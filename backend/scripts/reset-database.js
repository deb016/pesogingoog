// reset-database.js
// Section 1 of the update spec: wipe every Job Seeker / Employer account that was
// registered through the OLD system, along with their profiles, documents,
// applications, and verification history — while PRESERVING the default Admin
// account (and, by default, Staff accounts, since under the current system Staff
// can only ever be created by an Admin, not through public registration, so
// there is no "old public registration" Staff data to clean up).
//
// SAFETY:
//   1. Makes a timestamped mysqldump backup BEFORE touching anything (requires
//      the "mysqldump" command to be on your PATH — it ships inside XAMPP's
//      mysql/bin folder; on Windows that's usually C:\xampp\mysql\bin).
//   2. Runs as a DRY RUN by default — it only PRINTS what it would delete.
//   3. Only actually deletes when you pass --confirm.
//   4. Refuses to run if it can't find the default Admin account first.
//   5. Verifies the default Admin can still be found in the DB afterward.
//
// Usage:
//   node scripts/reset-database.js                 # dry run — shows counts, deletes nothing
//   node scripts/reset-database.js --confirm        # actually performs the reset
//   node scripts/reset-database.js --confirm --purge-staff
//                                                    # also removes Staff accounts (use only if
//                                                    # you specifically need to wipe Staff too)
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const mysql = require("mysql2/promise");

const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "peso_db";
const DEFAULT_ADMIN_EMAIL = "admin";

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const PURGE_STAFF = args.includes("--purge-staff");

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

// ---- 1. Backup FIRST, unconditionally (best-effort — warns but doesn't block
//         if mysqldump isn't on PATH, since some XAMPP installs need it added
//         manually; the dry-run/--confirm gate below is the real safety net). ----
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(__dirname, "..");
const backupPath = path.join(backupDir, `${DB_NAME}.backup-${stamp}.sql`);
try {
  const dumpArgs = ["-h", DB_HOST, "-P", String(DB_PORT), "-u", DB_USER];
  if (DB_PASSWORD) dumpArgs.push(`-p${DB_PASSWORD}`);
  dumpArgs.push(DB_NAME);
  const dump = execFileSync("mysqldump", dumpArgs, { maxBuffer: 1024 * 1024 * 200 });
  fs.writeFileSync(backupPath, dump);
  console.log(`✔ Backup created: ${backupPath}`);
} catch (err) {
  console.warn(`⚠ Could not create a mysqldump backup (${err.message.split("\n")[0]}). Continuing without one — make sure you have your own backup if this matters.`);
}

async function main() {
  const pool = await mysql.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });

  // ---- 2. Make sure the default Admin exists BEFORE we delete anything. ----
  const [[admin]] = await pool.query("SELECT email, role FROM users WHERE email = ? AND role = 'admin'", [DEFAULT_ADMIN_EMAIL]);
  if (!admin) {
    await pool.end();
    fail(
      `The default Admin account (${DEFAULT_ADMIN_EMAIL}) was not found. Refusing to run the reset ` +
        `so we never risk locking everyone out of the system. Start the backend once (node server.js) ` +
        `to have it re-seeded, then run this script again.`,
    );
  }
  console.log(`✔ Default Admin account confirmed present: ${DEFAULT_ADMIN_EMAIL}`);

  // ---- 3. Figure out which roles get wiped. ----
  const rolesToWipe = PURGE_STAFF ? ["job_seeker", "employer", "staff"] : ["job_seeker", "employer"];
  const [targets] = await pool.query(
    `SELECT email, role FROM users WHERE role IN (${rolesToWipe.map(() => "?").join(",")}) AND email != ?`,
    [...rolesToWipe, DEFAULT_ADMIN_EMAIL],
  );

  console.log(`\nFound ${targets.length} account(s) to remove (roles: ${rolesToWipe.join(", ")}):`);
  for (const t of targets) console.log(`  - ${t.email} (${t.role})`);

  if (targets.length === 0) {
    console.log("\nNothing to do — no matching accounts found. Admin (and Staff, unless --purge-staff) preserved.");
    await pool.end();
    process.exit(0);
  }

  if (!CONFIRM) {
    console.log(`\nThis was a DRY RUN — nothing was deleted. Re-run with --confirm to actually delete the above accounts.`);
    await pool.end();
    process.exit(0);
  }

  // ---- 4. Delete, inside a transaction, cleaning up every related table so
  //         nothing is left orphaned. ----
  const emails = targets.map((t) => t.email);
  const placeholders = emails.map(() => "?").join(",");

  await pool.beginTransaction();
  try {
    const [deletedDocs] = await pool.query(`DELETE FROM documents WHERE email IN (${placeholders})`, emails);
    const [deletedApps] = await pool.query(`DELETE FROM applications WHERE email IN (${placeholders})`, emails);
    const [deletedNotifs] = await pool.query(`DELETE FROM notifications WHERE email IN (${placeholders})`, emails);
    const [deletedSessions] = await pool.query(`DELETE FROM sessions WHERE email IN (${placeholders})`, emails);
    const [deletedHistory] = await pool.query(`DELETE FROM verification_history WHERE user_email IN (${placeholders})`, emails);
    // Vacancies posted by a removed Employer no longer have a valid owner — drop them too.
    const [deletedVacancies] = await pool.query(`DELETE FROM vacancies WHERE employer_email IN (${placeholders})`, emails);
    const [deletedUsers] = await pool.query(`DELETE FROM users WHERE email IN (${placeholders})`, emails);
    await pool.commit();

    console.log("\n✔ Reset complete:");
    console.log(`  - ${deletedUsers.affectedRows} user account(s) removed`);
    console.log(`  - ${deletedDocs.affectedRows} document(s) removed`);
    console.log(`  - ${deletedApps.affectedRows} application(s) removed`);
    console.log(`  - ${deletedNotifs.affectedRows} notification(s) removed`);
    console.log(`  - ${deletedSessions.affectedRows} session(s) removed`);
    console.log(`  - ${deletedHistory.affectedRows} verification-history record(s) removed`);
    console.log(`  - ${deletedVacancies.affectedRows} employer-owned vacancy postings removed`);
  } catch (err) {
    await pool.rollback();
    await pool.end();
    fail(`Reset failed and was rolled back: ${err.message}`);
  }

  // ---- 5. Final sanity check: Admin must still be able to log in. ----
  const [[adminAfter]] = await pool.query("SELECT email, role FROM users WHERE email = ? AND role = 'admin'", [DEFAULT_ADMIN_EMAIL]);
  await pool.end();
  if (!adminAfter) {
    fail("CRITICAL: the default Admin account is missing after the reset! Restore from the backup immediately: " + backupPath);
  }
  console.log(`\n✔ Verified: default Admin account (${DEFAULT_ADMIN_EMAIL}) is still present and intact.`);
  console.log(`\nDone. If anything looks wrong, restore the backup with:\n  mysql -u ${DB_USER}${DB_PASSWORD ? " -p" : ""} ${DB_NAME} < "${backupPath}"`);
}

main().catch((err) => fail(err.message));
