// db.js
// Persistent storage using MySQL/MariaDB — the database bundled with XAMPP.
// Connects to a local XAMPP MySQL/MariaDB instance (default: root, no password,
// 127.0.0.1:3306) and auto-creates the "peso_db" database and all tables the
// first time the server runs, so no manual phpMyAdmin setup is required.
//
// Requires: XAMPP's MySQL/MariaDB module running (start it from the XAMPP Control
// Panel), and MariaDB 10.2+ / MySQL 8.0.13+ (needed for TEXT columns to accept a
// DEFAULT value — this is true of every XAMPP release in common use today).
"use strict";

const mysql = require("mysql2/promise");
const crypto = require("node:crypto");

const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD || ""; // XAMPP's MySQL root has no password by default
const DB_NAME = process.env.DB_NAME || "peso_db";

// Hosted MySQL/MariaDB versions may reject TEXT defaults. Keep large payloads as
// nullable TEXT and use VARCHAR for fields whose values fit within 191 characters.
const TEXT_COLUMNS_WITH_LONG_VALUES = new Set([
  "disability_types",
  "job_seeker_category",
  "preferred_local_areas",
  "preferred_overseas_countries",
  "language_proficiency",
  "trainings",
  "eligibilities",
  "licenses",
  "other_skills",
  "work_experiences",
  "referred_to",
  "pwd_types",
  "other_skills_custom",
  "skills",
  "no_documents_declared",
  "verification_remarks",
  "employer_description",
  "employer_suspension_reason",
  "remarks",
  "employer_remarks",
  "related_record",
]);

function mysqlCompatibleTextDefaults(sql) {
  return sql.replace(
    /^(\s*)(\w+)\s+TEXT(\s+(?:NOT NULL\s+)?DEFAULT\s+'[^']*')/gm,
    (definition, indentation, column, defaultClause) =>
      `${indentation}${column} ${
        TEXT_COLUMNS_WITH_LONG_VALUES.has(column)
          ? "TEXT NULL"
          : `VARCHAR(191)${defaultClause}`
      }`,
  );
}

/* Roles: job_seeker | employer | staff | admin
 * Verification statuses (job seekers & employers): draft | pending_verification |
 * returned_for_completion | verified | rejected
 * Vacancy statuses: pending_approval | approved | returned_for_completion | rejected */

let pool;

/** Thin async wrapper around the mysql2 pool, shaped to stay close to the previous
 * better-sqlite3-style API (db.get/db.all/db.run) so the rest of the backend only
 * had to add "await", not be rewritten around a different query API. */
const db = {
  /** Returns the first matching row, or undefined if none. */
  async get(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows[0];
  },
  /** Returns every matching row as an array. */
  async all(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
  },
  /** For INSERT/UPDATE/DELETE. Returns { lastInsertRowid, changes } to mirror the
   * previous SQLite driver's result shape. */
  async run(sql, params = []) {
    const [result] = await pool.query(sql, params);
    return { lastInsertRowid: result.insertId, changes: result.affectedRows };
  },
  /** Runs several statements atomically on one dedicated connection (unlike plain
   * db.run, which may pull a different connection from the pool per call — fine
   * normally, but wrong for a multi-statement transaction). Pass an async callback
   * that receives { get, all, run } bound to that single connection; its return
   * value is returned from db.transaction(). Commits on success, rolls back and
   * rethrows on any error, and always releases the connection back to the pool. */
  async transaction(fn) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const trx = {
        async get(sql, params = []) {
          const [rows] = await conn.query(sql, params);
          return rows[0];
        },
        async all(sql, params = []) {
          const [rows] = await conn.query(sql, params);
          return rows;
        },
        async run(sql, params = []) {
          const [result] = await conn.query(sql, params);
          return { lastInsertRowid: result.insertId, changes: result.affectedRows };
        },
      };
      const result = await fn(trx);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};

const CREATE_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    email               VARCHAR(255) PRIMARY KEY,
    password_hash       TEXT NOT NULL,
    password_salt       TEXT NOT NULL,
    is_admin            INTEGER NOT NULL DEFAULT 0,
    role                TEXT NOT NULL DEFAULT 'job_seeker',
    name                TEXT,
    surname             TEXT DEFAULT '',
    first_name          TEXT DEFAULT '',
    middle_name         TEXT DEFAULT '',
    suffix              TEXT DEFAULT '',
    date_of_birth       TEXT DEFAULT '',
    sex                 TEXT DEFAULT '',
    religion            TEXT DEFAULT '',
    civil_status        TEXT DEFAULT '',
    house_street        TEXT DEFAULT '',
    barangay            TEXT DEFAULT '',
    municipality        TEXT DEFAULT '',
    province            TEXT DEFAULT '',
    tin                 TEXT DEFAULT '',
    height_ft           TEXT DEFAULT '',
    contact_number      TEXT DEFAULT '',
    disability_types    TEXT DEFAULT '[]',
    disability_others   TEXT DEFAULT '',
    employment_status   TEXT DEFAULT '',
    employment_sub_type TEXT DEFAULT '',
    employment_sub_type_others TEXT DEFAULT '',
    months_looking_for_work TEXT DEFAULT '',
    job_seeker_category TEXT DEFAULT '[]',
    terminated_abroad_country TEXT DEFAULT '',
    job_seeker_category_others TEXT DEFAULT '',
    is_ofw              TEXT DEFAULT '',
    ofw_country         TEXT DEFAULT '',
    ofw_return_date     TEXT DEFAULT '',
    is_4ps              TEXT DEFAULT '',
    household_id_no     TEXT DEFAULT '',
    preferred_occupation1 TEXT DEFAULT '',
    preferred_occupation2 TEXT DEFAULT '',
    work_type           TEXT DEFAULT '',
    work_location        TEXT DEFAULT '',
    preferred_local_areas TEXT DEFAULT '[]',
    preferred_overseas_countries TEXT DEFAULT '[]',
    language_proficiency TEXT DEFAULT '{}',
    currently_in_school TEXT DEFAULT '',
    education_level     TEXT DEFAULT '',
    course              TEXT DEFAULT '',
    year_graduated      TEXT DEFAULT '',
    undergrad_level_reached TEXT DEFAULT '',
    undergrad_year_last_attended TEXT DEFAULT '',
    trainings           TEXT DEFAULT '[]',
    eligibilities       TEXT DEFAULT '[]',
    licenses            TEXT DEFAULT '[]',
    technical_training  TEXT DEFAULT '',
    other_skills        TEXT DEFAULT '[]',
    other_skills_custom TEXT DEFAULT '',
    skills              TEXT DEFAULT '',
    company_name        TEXT DEFAULT '',
    position            TEXT DEFAULT '',
    experience          TEXT DEFAULT '',
    work_experiences    TEXT DEFAULT '[]',
    referred_to         TEXT DEFAULT '[]',
    referred_to_others  TEXT DEFAULT '',
    application_type    TEXT DEFAULT 'New Applicant',
    no_documents_declared TEXT DEFAULT '',

    -- Job seeker / employer verification workflow
    verification_status    TEXT NOT NULL DEFAULT 'draft',
    verification_remarks    TEXT DEFAULT '',
    verification_submitted_at TEXT DEFAULT '',
    verification_reviewed_at  TEXT DEFAULT '',
    verification_reviewed_by  TEXT DEFAULT '',
    verification_attempts   INTEGER NOT NULL DEFAULT 0,

    -- Employer profile fields (only used when role = 'employer')
    employer_company_name    TEXT DEFAULT '',
    employer_business_permit TEXT DEFAULT '',
    employer_industry        TEXT DEFAULT '',
    employer_address         TEXT DEFAULT '',
    employer_contact_person  TEXT DEFAULT '',
    employer_contact_number  TEXT DEFAULT '',
    employer_description     TEXT DEFAULT '',

    -- NSRP Form 2 (Establishment Registration Form) fields — Employer add-on module.
    employer_business_name   TEXT DEFAULT '',
    employer_trade_name      TEXT DEFAULT '',
    employer_acronym         TEXT DEFAULT '',
    employer_tin             TEXT DEFAULT '',
    employer_type            TEXT DEFAULT '',
    employer_category        TEXT DEFAULT '',
    employer_nature_of_work  TEXT DEFAULT '',
    employer_workforce_size  TEXT DEFAULT '',
    employer_street          TEXT DEFAULT '',
    employer_barangay        TEXT DEFAULT '',
    employer_municipality    TEXT DEFAULT '',
    employer_province        TEXT DEFAULT '',
    employer_owner_name      TEXT DEFAULT '',
    employer_position        TEXT DEFAULT '',
    employer_telephone       TEXT DEFAULT '',
    employer_mobile          TEXT DEFAULT '',
    employer_fax             TEXT DEFAULT '',
    employer_email           VARCHAR(255) DEFAULT '',
    employer_suspension_reason TEXT DEFAULT '',

    -- Gmail verification & password reset
    email_verified              INTEGER NOT NULL DEFAULT 0,
    email_verification_token    TEXT DEFAULT '',
    email_verification_expires  TEXT DEFAULT '',
    email_verification_last_sent TEXT DEFAULT '',
    password_reset_token        TEXT DEFAULT '',
    password_reset_expires      TEXT DEFAULT '',
    password_reset_used         INTEGER NOT NULL DEFAULT 0,

    created_at          TEXT NOT NULL,
    INDEX idx_users_employer_email (employer_email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS vacancies (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    title               TEXT NOT NULL,
    employer            TEXT NOT NULL,
    category            TEXT NOT NULL,
    location            TEXT NOT NULL,
    salary              TEXT NOT NULL,
    type                TEXT NOT NULL,
    slots               INTEGER NOT NULL,
    posted              TEXT NOT NULL,
    qualification       TEXT NOT NULL,
    description         TEXT NOT NULL,
    min_education_level TEXT NOT NULL,
    required_skills     TEXT NOT NULL,
    min_experience_years INTEGER NOT NULL,
    latitude            DECIMAL(10,7) NULL,
    longitude           DECIMAL(10,7) NULL,

    work_experience       TEXT DEFAULT '',
    other_qualifications  TEXT DEFAULT '',
    accepts_pwd            TEXT DEFAULT '',
    pwd_types               TEXT DEFAULT '[]',
    accepts_returning_ofw  TEXT DEFAULT '',
    course_shs_strand      TEXT DEFAULT '',
    license                 TEXT DEFAULT '',
    certification           TEXT DEFAULT '',
    eligibility              TEXT DEFAULT '',
    language_dialect        TEXT DEFAULT '',
    valid_until             TEXT DEFAULT '',
    expiry_days             INTEGER NOT NULL DEFAULT 5,

    employer_email      VARCHAR(255) NOT NULL DEFAULT '',
    status               TEXT NOT NULL DEFAULT 'approved',
    remarks               TEXT DEFAULT '',
    approved_by           TEXT DEFAULT '',
    approved_at           TEXT DEFAULT '',
    INDEX idx_vacancies_employer_email (employer_email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token       VARCHAR(255) PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS applications (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(255) NOT NULL,
    vacancy_id    INTEGER NOT NULL,
    status        TEXT NOT NULL,
    date_applied  TEXT NOT NULL,
    history       TEXT NOT NULL,

    referral_status TEXT NOT NULL DEFAULT 'not_referred',
    referred_at     TEXT DEFAULT '',
    employer_status TEXT DEFAULT '',
    employer_remarks TEXT DEFAULT '',
    referred_by     TEXT DEFAULT '',
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE,
    FOREIGN KEY (vacancy_id) REFERENCES vacancies(id),
    INDEX idx_applications_email (email),
    INDEX idx_applications_vacancy (vacancy_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS staff_referrals (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    seeker_email    VARCHAR(255) NOT NULL,
    vacancy_id      INTEGER NOT NULL,
    referred_by     VARCHAR(255) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL,
    INDEX idx_staff_referrals_seeker (seeker_email),
    INDEX idx_staff_referrals_vacancy (vacancy_id),
    UNIQUE KEY uq_staff_referrals_seeker_vacancy (seeker_email, vacancy_id),
    FOREIGN KEY (seeker_email) REFERENCES users(email) ON DELETE CASCADE,
    FOREIGN KEY (vacancy_id) REFERENCES vacancies(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    email   VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    date    TEXT NOT NULL,
    \`read\` INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE,
    INDEX idx_notifications_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS documents (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(255) NOT NULL,
    original_name TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL,
    uploaded_at   TEXT NOT NULL,
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE,
    INDEX idx_documents_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Every verification action (submit / verify / return / reject) for a job seeker
  // or employer profile creates a new row here. Rows are never overwritten or
  // deleted, so Admin can see the complete history of what happened to an account.
  `CREATE TABLE IF NOT EXISTS verification_history (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    user_email         VARCHAR(255) NOT NULL,
    user_role          TEXT NOT NULL,
    previous_status    TEXT NOT NULL,
    new_status         TEXT NOT NULL,
    action             TEXT NOT NULL,
    remarks            TEXT DEFAULT '',
    performed_by       TEXT DEFAULT '',
    performed_by_role  TEXT DEFAULT '',
    created_at         TEXT NOT NULL,
    INDEX idx_verification_history_email (user_email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // System-wide audit log for Admin.
  `CREATE TABLE IF NOT EXISTS activity_log (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    user_email      TEXT DEFAULT '',
    user_role       TEXT DEFAULT '',
    action          TEXT NOT NULL,
    related_record  TEXT DEFAULT '',
    performed_by    TEXT DEFAULT '',
    performed_by_role TEXT DEFAULT '',
    remarks         TEXT DEFAULT '',
    created_at      TEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/* ================= MIGRATIONS ================= *
 * Add any missing columns to tables created by older versions of this file.
 * MySQL/MariaDB's ALTER TABLE ADD COLUMN works the same way SQLite's did here. */
async function getColumnNames(table) {
  const rows = await db.all(`SHOW COLUMNS FROM \`${table}\``);
  return new Set(rows.map((c) => c.Field));
}

async function migrateUsersTable() {
  const existingCols = await getColumnNames("users");
  const wanted = [
    ["religion", "TEXT DEFAULT ''"],
    ["tin", "TEXT DEFAULT ''"],
    ["height_ft", "TEXT DEFAULT ''"],
    ["disability_types", "TEXT DEFAULT '[]'"],
    ["disability_others", "TEXT DEFAULT ''"],
    ["employment_sub_type", "TEXT DEFAULT ''"],
    ["employment_sub_type_others", "TEXT DEFAULT ''"],
    ["months_looking_for_work", "TEXT DEFAULT ''"],
    ["job_seeker_category", "TEXT DEFAULT '[]'"],
    ["terminated_abroad_country", "TEXT DEFAULT ''"],
    ["job_seeker_category_others", "TEXT DEFAULT ''"],
    ["ofw_country", "TEXT DEFAULT ''"],
    ["ofw_return_date", "TEXT DEFAULT ''"],
    ["household_id_no", "TEXT DEFAULT ''"],
    ["preferred_local_areas", "TEXT DEFAULT '[]'"],
    ["preferred_overseas_countries", "TEXT DEFAULT '[]'"],
    ["language_proficiency", "TEXT DEFAULT '{}'"],
    ["currently_in_school", "TEXT DEFAULT ''"],
    ["undergrad_level_reached", "TEXT DEFAULT ''"],
    ["undergrad_year_last_attended", "TEXT DEFAULT ''"],
    ["trainings", "TEXT DEFAULT '[]'"],
    ["eligibilities", "TEXT DEFAULT '[]'"],
    ["licenses", "TEXT DEFAULT '[]'"],
    ["other_skills_custom", "TEXT DEFAULT ''"],
    ["work_experiences", "TEXT DEFAULT '[]'"],
    ["referred_to", "TEXT DEFAULT '[]'"],
    ["referred_to_others", "TEXT DEFAULT ''"],
    ["application_type", "TEXT DEFAULT 'New Applicant'"],
    ["no_documents_declared", "TEXT DEFAULT ''"],
    ["avatar_data", "MEDIUMTEXT NULL"],
    ["role", "TEXT NOT NULL DEFAULT 'job_seeker'"],
    ["verification_status", "TEXT NOT NULL DEFAULT 'draft'"],
    ["verification_remarks", "TEXT DEFAULT ''"],
    ["verification_submitted_at", "TEXT DEFAULT ''"],
    ["verification_reviewed_at", "TEXT DEFAULT ''"],
    ["verification_reviewed_by", "TEXT DEFAULT ''"],
    ["verification_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["employer_company_name", "TEXT DEFAULT ''"],
    ["employer_business_permit", "TEXT DEFAULT ''"],
    ["employer_industry", "TEXT DEFAULT ''"],
    ["employer_address", "TEXT DEFAULT ''"],
    ["employer_contact_person", "TEXT DEFAULT ''"],
    ["employer_contact_number", "TEXT DEFAULT ''"],
    ["employer_description", "TEXT DEFAULT ''"],
    ["employer_business_name", "TEXT DEFAULT ''"],
    ["employer_trade_name", "TEXT DEFAULT ''"],
    ["employer_acronym", "TEXT DEFAULT ''"],
    ["employer_tin", "TEXT DEFAULT ''"],
    ["employer_type", "TEXT DEFAULT ''"],
    ["employer_category", "TEXT DEFAULT ''"],
    ["employer_nature_of_work", "TEXT DEFAULT ''"],
    ["employer_workforce_size", "TEXT DEFAULT ''"],
    ["employer_street", "TEXT DEFAULT ''"],
    ["employer_barangay", "TEXT DEFAULT ''"],
    ["employer_municipality", "TEXT DEFAULT ''"],
    ["employer_province", "TEXT DEFAULT ''"],
    ["employer_owner_name", "TEXT DEFAULT ''"],
    ["employer_position", "TEXT DEFAULT ''"],
    ["employer_telephone", "TEXT DEFAULT ''"],
    ["employer_mobile", "TEXT DEFAULT ''"],
    ["employer_fax", "TEXT DEFAULT ''"],
    ["employer_suspension_reason", "TEXT DEFAULT ''"],
    ["email_verified", "INTEGER NOT NULL DEFAULT 0"],
    ["email_verification_token", "TEXT DEFAULT ''"],
    ["email_verification_expires", "TEXT DEFAULT ''"],
    ["email_verification_last_sent", "TEXT DEFAULT ''"],
    ["password_reset_token", "TEXT DEFAULT ''"],
    ["password_reset_expires", "TEXT DEFAULT ''"],
    ["password_reset_used", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, def] of wanted) {
    if (!existingCols.has(name)) {
      await db.run(`ALTER TABLE users ADD COLUMN ${mysqlCompatibleTextDefaults(`${name} ${def}`)}`);
    }
  }
  await db.run(`UPDATE users SET role = 'admin' WHERE is_admin = 1 AND role != 'admin'`);
  await db.run(`UPDATE users SET email_verified = 1 WHERE role IN ('admin', 'staff')`);
}

async function migrateVacanciesTable() {
  const existingCols = await getColumnNames("vacancies");
  const wanted = [
    ["employer_email", "VARCHAR(255) NOT NULL DEFAULT ''"],
    ["status", "TEXT NOT NULL DEFAULT 'approved'"],
    ["remarks", "TEXT DEFAULT ''"],
    ["approved_by", "TEXT DEFAULT ''"],
    ["approved_at", "TEXT DEFAULT ''"],
    ["work_experience", "TEXT DEFAULT ''"],
    ["other_qualifications", "TEXT DEFAULT ''"],
    ["accepts_pwd", "TEXT DEFAULT ''"],
    ["pwd_types", "TEXT DEFAULT '[]'"],
    ["accepts_returning_ofw", "TEXT DEFAULT ''"],
    ["course_shs_strand", "TEXT DEFAULT ''"],
    ["license", "TEXT DEFAULT ''"],
    ["certification", "TEXT DEFAULT ''"],
    ["eligibility", "TEXT DEFAULT ''"],
    ["language_dialect", "TEXT DEFAULT ''"],
    ["valid_until", "TEXT DEFAULT ''"],
    ["expiry_days", "INTEGER NOT NULL DEFAULT 5"],
    ["latitude", "DECIMAL(10,7) NULL"],
    ["longitude", "DECIMAL(10,7) NULL"],
  ];
  for (const [name, def] of wanted) {
    if (!existingCols.has(name)) {
      await db.run(`ALTER TABLE vacancies ADD COLUMN ${mysqlCompatibleTextDefaults(`${name} ${def}`)}`);
    }
  }
}

async function migrateApplicationsTable() {
  const existingCols = await getColumnNames("applications");
  const wanted = [
    ["referral_status", "TEXT NOT NULL DEFAULT 'not_referred'"],
    ["referred_at", "TEXT DEFAULT ''"],
    ["employer_status", "TEXT DEFAULT ''"],
    ["employer_remarks", "TEXT DEFAULT ''"],
    ["referred_by", "TEXT DEFAULT ''"],
  ];
  for (const [name, def] of wanted) {
    if (!existingCols.has(name)) {
      await db.run(`ALTER TABLE applications ADD COLUMN ${mysqlCompatibleTextDefaults(`${name} ${def}`)}`);
    }
  }
}

/* ================= PASSWORD HASHING (unchanged — pure Node crypto, no DB) ========= */
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

/* ================= SEEDING (first run only) ================= */
const VACANCY_SEED = require("./seed-vacancies.json");

async function seedIfEmpty() {
  if (!VACANCY_SEED.length) return; // seed-vacancies.json is intentionally empty — the
  // system starts with no job listings so employers post their own from a clean slate.
  const { count } = await db.get("SELECT COUNT(*) AS count FROM vacancies");
  if (count > 0) return;
  for (const v of VACANCY_SEED) {
    await db.run(
      `INSERT INTO vacancies
        (id, title, employer, category, location, salary, type, slots, posted,
         qualification, description, min_education_level, required_skills, min_experience_years,
         employer_email, status, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'approved', ?)`,
      [
        v.id, v.title, v.employer, v.category, v.location, v.salary, v.type, v.slots, v.posted,
        JSON.stringify(v.qualification), v.description, v.minEducationLevel,
        JSON.stringify(v.requiredSkills), v.minExperienceYears, new Date().toISOString(),
      ],
    );
  }
  console.log(`Seeded ${VACANCY_SEED.length} vacancies.`);
}

/** One-time migration for databases created by an earlier version of this project,
 * where the seeded Admin/Staff accounts used real-looking emails
 * (admin@peso.gingoog.gov.ph / staff@peso.gingoog.gov.ph) instead of the current
 * simple admin/staff usernames. Renames those existing accounts in place and resets
 * them to the new default password, rather than leaving the old rows stranded and
 * creating fresh duplicate admin/staff accounts alongside them. Safe to run every
 * startup — it's a no-op once the rename has already happened once. */
async function migrateDefaultAccountCredentials() {
  const renames = [
    { oldEmail: "admin@peso.gingoog.gov.ph", newEmail: "admin", role: "admin", name: "Administrator" },
    { oldEmail: "staff@peso.gingoog.gov.ph", newEmail: "staff", role: "staff", name: "Staff" },
  ];
  for (const { oldEmail, newEmail, role, name } of renames) {
    const oldRow = await db.get("SELECT email FROM users WHERE email = ? AND role = ?", [oldEmail, role]);
    if (!oldRow) continue; // already migrated, or this is a fresh database — seed*IfMissing handles that case
    const alreadyMigrated = await db.get("SELECT email FROM users WHERE email = ?", [newEmail]);
    if (alreadyMigrated) continue; // new-style account already exists too; leave the old one alone rather than guess

    // Clear out anything referencing the old email first — sessions/notifications are
    // declared with a foreign key back to users(email), which blocks renaming a row
    // that's still referenced. Logging out any active session here is expected: the
    // password is changing too, so a fresh login is needed regardless.
    await db.run("DELETE FROM sessions WHERE email = ?", [oldEmail]);
    await db.run("DELETE FROM notifications WHERE email = ?", [oldEmail]);

    const { hash, salt } = hashPassword("12345678");
    await db.run("UPDATE users SET email = ?, password_hash = ?, password_salt = ?, name = ? WHERE email = ?", [newEmail, hash, salt, name, oldEmail]);
    console.log(`Migrated existing ${role} account: ${oldEmail} -> ${newEmail} / 12345678`);
  }
}

async function seedAdminIfMissing() {
  const existing = await db.get("SELECT email FROM users WHERE email = ?", ["admin"]);
  if (existing) return;
  const { hash, salt } = hashPassword("12345678");
  await db.run(
    `INSERT INTO users (email, password_hash, password_salt, is_admin, role, name, verification_status, email_verified, created_at)
     VALUES (?, ?, ?, 1, 'admin', ?, 'verified', 1, ?)`,
    ["admin", hash, salt, "Administrator", new Date().toISOString()],
  );
  console.log("Seeded default admin account: admin / 12345678  (change this password before going live)");
}

async function seedStaffIfMissing() {
  const existing = await db.get("SELECT email FROM users WHERE email = ?", ["staff"]);
  if (existing) return;
  const { hash, salt } = hashPassword("12345678");
  await db.run(
    `INSERT INTO users (email, password_hash, password_salt, is_admin, role, name, verification_status, email_verified, created_at)
     VALUES (?, ?, ?, 0, 'staff', ?, 'verified', 1, ?)`,
    ["staff", hash, salt, "Staff", new Date().toISOString()],
  );
  console.log("Seeded default staff account: staff / 12345678  (change this password before going live)");
}

/* ================= STARTUP ================= *
 * Everything below runs once, in order, before the server starts accepting
 * requests. server.js awaits `ready` before calling server.listen(). */
async function init() {
  // Connect without a database first so we can create "peso_db" if it's missing —
  // mirrors the old SQLite behavior of "just works" with zero manual setup beyond
  // starting XAMPP's MySQL module.
  const bootstrap = await mysql.createConnection({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, multipleStatements: false,
  });
  try {
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await bootstrap.end();
  }

  pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
    waitForConnections: true, connectionLimit: 10, charset: "utf8mb4_unicode_ci",
  });

  for (const statement of CREATE_TABLE_STATEMENTS) {
    await pool.query(mysqlCompatibleTextDefaults(statement));
  }

  await migrateUsersTable();
  await migrateVacanciesTable();
  await migrateApplicationsTable();
  await migrateDefaultAccountCredentials();

  await seedIfEmpty();
  await seedAdminIfMissing();
  await seedStaffIfMissing();

  console.log(`Connected to MySQL/MariaDB (XAMPP) — database "${DB_NAME}" at ${DB_HOST}:${DB_PORT}`);
}

const ready = init().catch((err) => {
  console.error("\nFailed to connect to MySQL/MariaDB.");
  console.error("Make sure XAMPP's MySQL module is running (open the XAMPP Control Panel and click Start next to MySQL), then restart this server.");
  console.error("Connection settings used: host=" + DB_HOST + " port=" + DB_PORT + " user=" + DB_USER + " database=" + DB_NAME);
  console.error(err.message);
  process.exit(1);
});

module.exports = { db, hashPassword, verifyPassword, ready };
