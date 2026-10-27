// reset-vacancies.js
// Item 3 of the update spec: remove the old sample/system job listings that were
// seeded into the database on first run, so the system is a clean slate for
// employers to post their own vacancies — WITHOUT touching job-posting functionality,
// employer accounts, seeker accounts, or any vacancy an employer has actually posted.
//
// Sample/system vacancies are identified the same way the rest of the codebase
// already identifies them: employer_email = '' (see backend/db.js — "Seed vacancies
// have no owning employer account"). Any vacancy with a non-empty employer_email was
// posted by a real Employer account and is never touched by this script unless you
// explicitly pass --all.
//
// SAFETY:
//   1. Makes a timestamped mysqldump backup BEFORE touching anything (requires
//      "mysqldump" on your PATH — ships inside XAMPP's mysql/bin folder).
//   2. Runs as a DRY RUN by default — it only PRINTS what it would delete.
//   3. Only actually deletes when you pass --confirm.
//   4. Cleans up related applications/notifications for the removed vacancies too,
//      so nothing is left pointing at a vacancy_id that no longer exists.
//
// Usage:
//   node scripts/reset-vacancies.js                 # dry run — shows what it would remove
//   node scripts/reset-vacancies.js --confirm        # removes the old sample listings
//   node scripts/reset-vacancies.js --confirm --all  # removes ALL vacancies, including
//                                                     # any an employer has posted (rarely
//                                                     # what you want — use with care)
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

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const ALL = args.includes("--all");

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

// ---- 1. Backup FIRST, unconditionally (best-effort). ----
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(__dirname, "..", `${DB_NAME}.backup-${stamp}.sql`);
try {
  const dumpArgs = ["-h", DB_HOST, "-P", String(DB_PORT), "-u", DB_USER];
  if (DB_PASSWORD) dumpArgs.push(`-p${DB_PASSWORD}`);
  dumpArgs.push(DB_NAME);
  const dump = execFileSync("mysqldump", dumpArgs, { maxBuffer: 1024 * 1024 * 200 });
  fs.writeFileSync(backupPath, dump);
  console.log(`✔ Backup created: ${backupPath}`);
} catch (err) {
  console.warn(`⚠ Could not create a mysqldump backup (${err.message.split("\n")[0]}). Continuing without one.`);
}

async function main() {
  const pool = await mysql.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });

  // ---- 2. Figure out which vacancies get removed. ----
  const [targets] = ALL
    ? await pool.query("SELECT id, title, employer, employer_email FROM vacancies")
    : await pool.query("SELECT id, title, employer, employer_email FROM vacancies WHERE employer_email = ''");

  console.log(`\nFound ${targets.length} vacancy record(s) to remove${ALL ? " (--all: including employer-posted ones)" : " (system-seeded sample listings only)"}:`);
  for (const t of targets) console.log(`  - #${t.id} "${t.title}" (${t.employer_email ? `posted by ${t.employer_email}` : "sample listing"})`);

  if (targets.length === 0) {
    console.log("\nNothing to do — no matching vacancies found.");
    await pool.end();
    process.exit(0);
  }

  if (!CONFIRM) {
    console.log(`\nThis was a DRY RUN — nothing was deleted. Re-run with --confirm to actually delete the above vacancies.`);
    await pool.end();
    process.exit(0);
  }

  // ---- 3. Delete, inside a transaction, cleaning up every related table so
  //         nothing is left orphaned (Job Seeker applications, notifications). ----
  const ids = targets.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");

  await pool.beginTransaction();
  try {
    const [deletedApps] = await pool.query(`DELETE FROM applications WHERE vacancy_id IN (${placeholders})`, ids);
    const [deletedVacancies] = await pool.query(`DELETE FROM vacancies WHERE id IN (${placeholders})`, ids);
    await pool.commit();

    console.log("\n✔ Reset complete:");
    console.log(`  - ${deletedVacancies.affectedRows} vacancy record(s) removed`);
    console.log(`  - ${deletedApps.affectedRows} related application(s) removed`);
    console.log(`\nJob-posting functionality itself is untouched — Employers can add new vacancies immediately (POST /api/employer/vacancies), Staff still approves them as usual, and every Job Seeker/Employer account is unaffected.`);
  } catch (err) {
    await pool.rollback();
    await pool.end();
    fail(`Reset failed and was rolled back: ${err.message}`);
  }

  await pool.end();
  console.log(`\nDone. If anything looks wrong, restore the backup with:\n  mysql -u ${DB_USER}${DB_PASSWORD ? " -p" : ""} ${DB_NAME} < "${backupPath}"`);
}

main().catch((err) => fail(err.message));
