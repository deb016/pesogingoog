// server.js
// PESO Gingoog City — Job Matching and Employment Management System backend.
// Plain Node.js (http) + MySQL/MariaDB via XAMPP. Start XAMPP's MySQL module first,
// then run with: node server.js
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

// Tiny built-in .env loader (no dependency needed) — reads backend/.env if it
// exists and applies any variables not already set in the real environment.
// See .env.example for the Gmail SMTP settings this enables.
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const { db, hashPassword, verifyPassword, ready: dbReady } = require("./db");
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendStaffFollowUpEmail,
  sendProfileReviewEmail,
  sendReferralInvitationEmail,
  sendVacancyReviewEmail,
} = require("./mailer");

const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB per file, generous for a resume/ID scan
const MAX_AVATAR_BYTES = 1024 * 1024;

const ROLES = ["job_seeker", "employer", "staff", "admin"];
// Job Seekers and Employers must register with a Gmail address (Section 5).
const GMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i;
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{6,}$/;
const PASSWORD_REQUIREMENTS_MESSAGE = "Password must be at least 6 characters and include at least one letter and one number.";
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds, Section 7
const UNVERIFIED_ACCOUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour, Section 10
const VERIFICATION_STATUSES = ["draft", "pending_verification", "returned_for_completion", "verified", "rejected", "suspended"];
const VACANCY_STATUSES = ["draft", "pending_approval", "approved", "returned_for_completion", "rejected", "expired", "closed"];
const PUBLIC_VACANCY_VALIDITY_SQL = `
  LOWER(TRIM(COALESCE(title, ''))) NOT IN ('', 'none', 'null', 'undefined')
  AND LOWER(TRIM(COALESCE(category, ''))) NOT IN ('', 'none', 'null', 'undefined')
`;
const locationSearchCache = new Map();
const locationReverseCache = new Map();
let nominatimQueue = Promise.resolve();

function isStrongPassword(password) {
  return typeof password === "string" && PASSWORD_REGEX.test(password);
}
function isMissingVacancyValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !normalized || ["none", "null", "undefined"].includes(normalized);
}
let lastNominatimRequestAt = 0;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ================= SMALL HELPERS ================= */
function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  });
  res.end(json);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES * 2) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}
function nowIso() {
  return new Date().toISOString();
}
function today() {
  return nowIso().slice(0, 10);
}
function vacancyExpiryDate(days, startDate = today()) {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function isValidVacancyExpiryDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 2 && days <= 5;
}
async function migratePendingStaffReferrals() {
  const legacyReferrals = await db.all(`
    SELECT id, email, vacancy_id, referred_by, referred_at, date_applied
    FROM applications
    WHERE referral_status = 'referred' AND status = 'pending'
      AND (employer_status IS NULL OR employer_status = '')
  `);
  for (const referral of legacyReferrals) {
    await db.transaction(async (trx) => {
      await trx.run(`
        INSERT INTO staff_referrals (seeker_email, vacancy_id, referred_by, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
        ON DUPLICATE KEY UPDATE
          referred_by = VALUES(referred_by),
          created_at = VALUES(created_at),
          status = IF(status = 'cancelled', 'pending', status)
      `, [
        referral.email,
        referral.vacancy_id,
        referral.referred_by || "",
        referral.referred_at || `${referral.date_applied}T00:00:00.000Z`,
      ]);
      await trx.run("DELETE FROM applications WHERE id = ?", [referral.id]);
    });
  }
}
async function removeUserUploadDirectory(email) {
  const userDirectory = path.join(UPLOAD_DIR, crypto.createHash("sha256").update(email).digest("hex"));
  try {
    await fs.promises.rm(userDirectory, { recursive: true, force: true });
  } catch (error) {
    console.error(`Could not remove uploaded files for deleted account ${email}:`, error);
  }
}
async function sweepExpiredUnverifiedAccounts() {
  const cutoff = nowIso();
  const expiredUsers = await db.all(`
    SELECT email FROM users
    WHERE role IN ('job_seeker', 'employer')
      AND email_verified = 0
      AND registration_expires_at IS NOT NULL
      AND registration_expires_at <= ?
  `, [cutoff]);

  for (const user of expiredUsers) {
    const result = await db.run(`
      DELETE FROM users
      WHERE email = ?
        AND role IN ('job_seeker', 'employer')
        AND email_verified = 0
        AND registration_expires_at IS NOT NULL
        AND registration_expires_at <= ?
    `, [user.email, cutoff]);
    if (result.changes > 0) await removeUserUploadDirectory(user.email);
  }
}

/* ================= AUTH HELPERS ================= */
async function createSession(email) {
  const token = crypto.randomBytes(32).toString("hex");
  (await db.run("INSERT INTO sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)", [token, email, nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString(),]));
  return token;
}
async function getUserFromRequest(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const session = (await db.get("SELECT * FROM sessions WHERE token = ?", [token]));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    (await db.run("DELETE FROM sessions WHERE token = ?", [token]));
    return null;
  }
  return (await db.get("SELECT * FROM users WHERE email = ?", [session.email])) || null;
}

/** Enforces role-based access using the authenticated account's stored role.
 * Every protected route calls this (or requireAnyAuth) rather than reading
 * req.body.role or similar. */
async function requireRole(req, res, roles) {
  const user = await getUserFromRequest(req);
  if (!user) {
    send(res, 401, { error: "Not authenticated." });
    return null;
  }
  if (!roles.includes(user.role)) {
    send(res, 403, { error: "You do not have permission to access this resource." });
    return null;
  }
  return user;
}
async function requireAnyAuth(req, res) {
  return await requireRole(req, res, ROLES);
}
async function requireStaffOrAdmin(req, res) {
  return await requireRole(req, res, ["staff", "admin"]);
}
async function requireAdmin(req, res) {
  return await requireRole(req, res, ["admin"]);
}

/* ================= AUDIT / VERIFICATION HISTORY HELPERS =================
 * Rule 10 / Section 12: every verification action creates a new row and old
 * rows are never overwritten. Section 14: every important system action is
 * logged for the Admin activity log, also append-only. */
async function logVerification({ userEmail, userRole, previousStatus, newStatus, action, remarks, performedBy, performedByRole }) {
  (await db.run(`
    INSERT INTO verification_history
      (user_email, user_role, previous_status, new_status, action, remarks, performed_by, performed_by_role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [userEmail, userRole, previousStatus, newStatus, action, remarks || "", performedBy || "", performedByRole || "", nowIso()]));
}
async function logActivity({ userEmail, userRole, action, relatedRecord, performedBy, performedByRole, remarks }) {
  (await db.run(`
    INSERT INTO activity_log (user_email, user_role, action, related_record, performed_by, performed_by_role, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [userEmail || "", userRole || "", action, relatedRecord || "", performedBy || "", performedByRole || "", remarks || "", nowIso()]));
}
async function notify(email, message) {
  (await db.run("INSERT INTO notifications (email, message, date, `read`) VALUES (?, ?, ?, 0)", [email, message, today()]));
}

/* ================= SERIALIZERS (snake_case DB rows -> the shapes the frontend already uses) ================= */
function serializeUser(row) {
  if (!row) return null;
  return {
    email: row.email,
    isAdmin: !!row.is_admin,
    role: row.role || "job_seeker",
    name: row.name || "",
    surname: row.surname || "",
    firstName: row.first_name || "",
    middleName: row.middle_name || "",
    suffix: row.suffix || "",
    dateOfBirth: row.date_of_birth || "",
    sex: row.sex || "",
    religion: row.religion || "",
    civilStatus: row.civil_status || "",
    houseStreet: row.house_street || "",
    barangay: row.barangay || "",
    municipality: row.municipality || "",
    province: row.province || "",
    tin: row.tin || "",
    heightFt: row.height_ft || "",
    contactNumber: row.contact_number || "",
    disabilityTypes: JSON.parse(row.disability_types || "[]"),
    disabilityOthers: row.disability_others || "",
    employmentStatus: row.employment_status || "",
    employmentSubType: row.employment_sub_type || "",
    employmentSubTypeOthers: row.employment_sub_type_others || "",
    monthsLookingForWork: row.months_looking_for_work || "",
    jobSeekerCategory: JSON.parse(row.job_seeker_category || "[]"),
    terminatedAbroadCountry: row.terminated_abroad_country || "",
    jobSeekerCategoryOthers: row.job_seeker_category_others || "",
    isOFW: row.is_ofw || "",
    ofwCountry: row.ofw_country || "",
    ofwReturnDate: row.ofw_return_date || "",
    is4Ps: row.is_4ps || "",
    householdIdNo: row.household_id_no || "",
    preferredOccupation1: row.preferred_occupation1 || "",
    preferredOccupation2: row.preferred_occupation2 || "",
    workType: row.work_type || "",
    workLocation: row.work_location || "",
    preferredLocalAreas: JSON.parse(row.preferred_local_areas || "[]"),
    preferredOverseasCountries: JSON.parse(row.preferred_overseas_countries || "[]"),
    languageProficiency: JSON.parse(row.language_proficiency || "{}"),
    currentlyInSchool: row.currently_in_school || "",
    educationLevel: row.education_level || "",
    course: row.course || "",
    yearGraduated: row.year_graduated || "",
    undergradLevelReached: row.undergrad_level_reached || "",
    undergradYearLastAttended: row.undergrad_year_last_attended || "",
    trainings: JSON.parse(row.trainings || "[]"),
    eligibilities: JSON.parse(row.eligibilities || "[]"),
    licenses: JSON.parse(row.licenses || "[]"),
    technicalTraining: row.technical_training || "",
    otherSkills: JSON.parse(row.other_skills || "[]"),
    otherSkillsCustom: row.other_skills_custom || "",
    skills: row.skills || "",
    workExperiences: JSON.parse(row.work_experiences || "[]"),
    referredTo: JSON.parse(row.referred_to || "[]"),
    referredToOthers: row.referred_to_others || "",
    applicationType: row.application_type || "New Applicant",
    companyName: row.company_name || "",
    position: row.position || "",
    experience: row.experience || "",
    noDocumentsDeclared: row.no_documents_declared || "",

    verificationStatus: row.verification_status || "draft",
    verificationRemarks: row.verification_remarks || "",
    verificationSubmittedAt: row.verification_submitted_at || "",
    verificationReviewedAt: row.verification_reviewed_at || "",
    verificationReviewedBy: row.verification_reviewed_by || "",
    verificationAttempts: row.verification_attempts || 0,
    registrationExpiresAt: row.email_verified ? "" : row.registration_expires_at || "",
    profileEditRequestStatus: row.profile_edit_request_status || "none",
    profileEditRequestRemarks: row.profile_edit_request_remarks || "",
    profileEditRequestedAt: row.profile_edit_requested_at || "",

    employerCompanyName: row.employer_company_name || "",
    employerBusinessPermit: row.employer_business_permit || "",
    employerIndustry: row.employer_industry || "",
    employerAddress: row.employer_address || "",
    employerContactPerson: row.employer_contact_person || "",
    employerContactNumber: row.employer_contact_number || "",
    employerDescription: row.employer_description || "",

    // NSRP Form 2 (Establishment Registration Form) fields
    employerBusinessName: row.employer_business_name || "",
    employerTradeName: row.employer_trade_name || "",
    employerAcronym: row.employer_acronym || "",
    employerTin: row.employer_tin || "",
    employerType: row.employer_type || "",
    employerCategory: row.employer_category || "",
    employerNatureOfWork: row.employer_nature_of_work || "",
    employerWorkforceSize: row.employer_workforce_size || "",
    employerStreet: row.employer_street || "",
    employerBarangay: row.employer_barangay || "",
    employerMunicipality: row.employer_municipality || "",
    employerProvince: row.employer_province || "",
    employerOwnerName: row.employer_owner_name || "",
    employerPosition: row.employer_position || "",
    employerTelephone: row.employer_telephone || "",
    employerMobile: row.employer_mobile || "",
    employerFax: row.employer_fax || "",
    employerEmail: row.employer_email || "",
    employerSuspensionReason: row.employer_suspension_reason || "",
  };
}
function serializeVacancy(row) {
  return {
    id: row.id,
    title: row.title,
    employer: row.employer,
    category: row.category,
    location: row.location,
    salary: row.salary,
    type: row.type,
    slots: row.slots,
    posted: row.posted,
    postedAt: ["approved", "expired", "closed"].includes(row.status) && row.approved_at
      ? row.approved_at
      : row.posted,
    qualification: JSON.parse(row.qualification),
    description: row.description,
    minEducationLevel: row.min_education_level,
    requiredSkills: JSON.parse(row.required_skills),
    minExperienceYears: row.min_experience_years,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    employerEmail: row.employer_email || "",
    status: row.status || "approved",
    remarks: row.remarks || "",
    approvedBy: row.approved_by || "",
    approvedAt: row.approved_at || "",

    // NSRP Form 2 (Vacancy Details / Qualification Requirements / Posting Details)
    workExperience: row.work_experience || "",
    otherQualifications: row.other_qualifications || "",
    acceptsPwd: row.accepts_pwd || "",
    pwdTypes: JSON.parse(row.pwd_types || "[]"),
    acceptsReturningOfw: row.accepts_returning_ofw || "",
    courseShsStrand: row.course_shs_strand || "",
    license: row.license || "",
    certification: row.certification || "",
    eligibility: row.eligibility || "",
    languageDialect: row.language_dialect || "",
    validUntil: row.valid_until || "",
    expiryDays: isValidVacancyExpiryDays(row.expiry_days) ? Number(row.expiry_days) : 5,
  };
}
function validateReportDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
async function getDailyReport(date) {
  const start = `${date}T00:00:00.000Z`;
  const endDate = new Date(`${date}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate.toISOString();
  const [vacancies, seekers] = await Promise.all([
    db.all(`
      SELECT title, employer, location, slots, posted, approved_at, status
      FROM vacancies
      WHERE LEFT(CASE WHEN status IN ('approved', 'expired', 'closed') AND approved_at != '' THEN approved_at ELSE posted END, 10) = ?
      ORDER BY LOWER(title), id
    `, [date]),
    db.all(`
      SELECT name, first_name, middle_name, surname, suffix, created_at,
        education_level, skills, verification_status
      FROM users
      WHERE role = 'job_seeker' AND created_at >= ? AND created_at < ?
      ORDER BY LOWER(COALESCE(name, '')), email
    `, [start, end]),
  ]);
  return {
    date,
    vacancies: vacancies.map((row) => ({
      title: row.title || "",
      employer: row.employer || "",
      location: row.location || "",
      slots: Number(row.slots) || 0,
      posted: ["approved", "expired", "closed"].includes(row.status) && row.approved_at
        ? row.approved_at
        : row.posted || "",
      status: row.status || "",
    })),
    seekers: seekers.map((row) => ({
      name: row.name?.trim() || [row.first_name, row.middle_name, row.surname, row.suffix].filter(Boolean).join(" "),
      registeredAt: row.created_at || "",
      educationLevel: row.education_level || "",
      skills: row.skills || "",
      verificationStatus: row.verification_status || "",
    })),
  };
}
function pdfText(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\xff]/g, " ");
}
function formatReportPostedAt(value) {
  const hasTime = /[T ]\d{2}:\d{2}/.test(value);
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(date.getTime())) return value;
  const options = hasTime
    ? { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }
    : { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
  const formatted = new Intl.DateTimeFormat("en-PH", options).format(date);
  return hasTime ? formatted : `${formatted} (time unavailable)`;
}
function buildDailyReportPdf(report, reportType) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 38, right: 36, bottom: 42, left: 36 }, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    const pageBottom = () => doc.page.height - doc.page.margins.bottom - 12;

    doc.font("Helvetica-Bold").fontSize(17).fillColor("#0b2c6b").text("PESO Gingoog City", { align: "center" });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10).fillColor("#1c2333")
      .text(`${reportType === "vacancies" ? "Job Vacancy Report" : reportType === "seekers" ? "Job Seeker Registration Report" : "Complete Daily Report"}`, { align: "center" })
      .text(`Report date: ${report.date}    Generated: ${new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(new Date())}`, { align: "center" });
    doc.moveDown(1);

    const drawTable = (heading, columns, rows, emptyMessage) => {
      if (doc.y + 44 > pageBottom()) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#0b2c6b").text(heading);
      doc.moveDown(0.15);
      doc.font("Helvetica").fontSize(9).fillColor("#1c2333")
        .text(`Total records: ${rows.length}`);
      doc.moveDown(0.35);

      const drawHeader = () => {
        const top = doc.y;
        doc.save().rect(36, top, doc.page.width - 72, 22).fill("#eaf0f8").restore();
        let x = 36;
        for (const column of columns) {
          doc.font("Helvetica-Bold").fontSize(8).fillColor("#0b2c6b")
            .text(column.label, x + 4, top + 6, { width: column.width - 8, height: 14, lineBreak: false, ellipsis: true });
          x += column.width;
        }
        doc.y = top + 22;
      };

      drawHeader();
      if (!rows.length) {
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#5b6472").text(emptyMessage, 40, doc.y + 7);
        doc.y += 24;
        return;
      }
      for (const row of rows) {
        const values = columns.map((column) => pdfText(column.value(row)));
        const heights = values.map((value, index) => doc.font("Helvetica").fontSize(8).heightOfString(value || "-", { width: columns[index].width - 10 }));
        const rowHeight = Math.max(24, ...heights.map((height) => height + 10));
        if (doc.y + rowHeight > pageBottom()) {
          doc.addPage();
          drawHeader();
        }
        const top = doc.y;
        if (Math.floor(top / 2) % 2 === 0) doc.save().rect(36, top, doc.page.width - 72, rowHeight).fill("#fafbfd").restore();
        let x = 36;
        for (let index = 0; index < columns.length; index += 1) {
          doc.font("Helvetica").fontSize(8).fillColor("#1c2333")
            .text(values[index] || "-", x + 5, top + 5, { width: columns[index].width - 10, height: rowHeight - 8 });
          x += columns[index].width;
        }
        doc.y = top + rowHeight;
        doc.save().moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).lineWidth(0.4).strokeColor("#dfe3ea").stroke().restore();
      }
      doc.moveDown(1);
    };

    const vacancyColumns = [
      { label: "Job title", width: 184, value: (row) => row.title },
      { label: "Employer", width: 145, value: (row) => row.employer },
      { label: "Location", width: 150, value: (row) => row.location },
      { label: "Positions", width: 58, value: (row) => row.slots },
      { label: "Date and time posted", width: 92, value: (row) => formatReportPostedAt(row.posted) },
      { label: "Status", width: 100, value: (row) => row.status },
    ];
    const seekerColumns = [
      { label: "Job seeker", width: 160, value: (row) => row.name },
      { label: "Registered", width: 105, value: (row) => row.registeredAt },
      { label: "Education", width: 150, value: (row) => row.educationLevel },
      { label: "Skills / qualifications", width: 205, value: (row) => row.skills },
      { label: "Verification", width: 109, value: (row) => row.verificationStatus },
    ];
    if (reportType !== "seekers") drawTable("Section A: Job Vacancy Report", vacancyColumns, report.vacancies, "No job vacancies found for this date.");
    if (reportType !== "vacancies") drawTable(reportType === "complete" ? "Section B: Job Seeker Report" : "Job Seeker Report", seekerColumns, report.seekers, "No job seekers registered on this date.");

    const pages = doc.bufferedPageRange();
    for (let page = pages.start; page < pages.start + pages.count; page += 1) {
      doc.switchToPage(page);
      doc.font("Helvetica").fontSize(8).fillColor("#5b6472")
        .text(`PESO Gingoog City  |  ${report.date}`, 36, pageBottom(), { width: doc.page.width - 72, align: "center" });
      doc.font("Helvetica").fontSize(8).fillColor("#5b6472")
        .text(`Page ${page + 1} of ${pages.count}`, 36, pageBottom(), { width: doc.page.width - 72, align: "right" });
    }
    doc.end();
  });
}
function serializeApplication(row) {
  return {
    id: row.id,
    vacancyId: row.vacancy_id,
    status: row.status,
    dateApplied: row.date_applied,
    history: JSON.parse(row.history),
    employerStatus: row.employer_status || "",
    employerRemarks: row.employer_remarks || "",
    isStaffReferral: row.referral_status === "referred",
    referredBy: row.referred_by || "",
    referredAt: row.referred_at || "",
  };
}
function serializeNotification(row) {
  return { id: row.id, message: row.message, date: row.date, read: !!row.read };
}
function serializeDocument(row) {
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    uploadedAt: row.uploaded_at,
    // The download URL is admin/staff-only in this build (see /api/admin/documents/:id) —
    // seekers don't need to re-download their own files, just see what's on file.
  };
}
function serializeVerificationHistory(row) {
  return {
    id: row.id,
    userEmail: row.user_email,
    userRole: row.user_role,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    action: row.action,
    remarks: row.remarks || "",
    performedBy: row.performed_by || "",
    performedByRole: row.performed_by_role || "",
    createdAt: row.created_at,
  };
}
function serializeActivity(row) {
  return {
    id: row.id,
    userEmail: row.user_email || "",
    userRole: row.user_role || "",
    action: row.action,
    relatedRecord: row.related_record || "",
    performedBy: row.performed_by || "",
    performedByRole: row.performed_by_role || "",
    remarks: row.remarks || "",
    createdAt: row.created_at,
  };
}

async function getVerificationHistory(email) {
  return (await db.all("SELECT * FROM verification_history WHERE user_email = ? ORDER BY id ASC", [email])).map(serializeVerificationHistory);
}

/* ================= REQUIRED PROFILE FIELDS (mirrors the frontend's isProfileComplete) =================
 * Every field across Sections I-VIII is required — "None" is an acceptable answer for
 * fields that don't apply to a given seeker, but the field can't be left blank. Section
 * IX ("For Use of PESO Only") is filled in by staff, not the seeker, so it's excluded.
 * Section VIII (Requirements/Documents) has no text field of its own — it's satisfied
 * by docCount > 0 or the seeker's noDocumentsDeclared flag, checked separately below. */
const REQUIRED_PROFILE_FIELDS = [
  "surname", "firstName", "middleName", "suffix", "dateOfBirth", "sex", "religion", "civilStatus",
  "houseStreet", "barangay", "tin", "heightFt", "contactNumber", "email", "disabilityOthers",
  "employmentSubTypeOthers", "monthsLookingForWork", "terminatedAbroadCountry", "jobSeekerCategoryOthers",
  "ofwCountry", "ofwReturnDate", "householdIdNo",
  "preferredOccupation1", "preferredOccupation2", "preferredLocalAreas", "preferredOverseasCountries",
  "educationLevel", "course", "yearGraduated", "undergradLevelReached", "undergradYearLastAttended",
  "technicalTraining",
  "otherSkillsCustom", "skills",
  "companyName", "position", "experience",
];
function isProfileComplete(user, docCount = 0) {
  const documentsOk = docCount > 0 || user.noDocumentsDeclared === "Yes";
  return documentsOk && REQUIRED_PROFILE_FIELDS.every((f) => user[f] && String(user[f]).trim() !== "");
}

const REQUIRED_EMPLOYER_FIELDS = [
  "employerBusinessName", "employerTin", "employerType", "employerIndustry",
  "employerStreet", "employerBarangay", "employerMunicipality", "employerProvince",
  "employerOwnerName", "employerContactPerson", "employerPosition", "employerMobile", "employerEmail",
];
function isEmployerProfileComplete(user) {
  return REQUIRED_EMPLOYER_FIELDS.every((f) => user[f] && String(user[f]).trim() !== "");
}
/** Vacancy Details / Posting Details (Section 6): auto-expire any APPROVED vacancy
 * whose Valid Until date has passed. Called by the periodic expiry task and before
 * serving vacancy lists so expired jobs are not left visible if a timer was delayed. */
async function sweepExpiredVacancies() {
  (await db.run(`
    UPDATE vacancies SET status = 'expired'
    WHERE status = 'approved' AND valid_until != '' AND valid_until < ?
  `, [today()]));
}

/* ================= WEIGHTED ATTRIBUTE-BASED MATCHING (server-side) =================
 * Server-side port of frontend/src/matching.ts, used by the Staff Referral function
 * (Section 3) to confirm a Seeker actually meets a vacancy's requirements before
 * Staff is allowed to refer them. Weights: Education 40% + Skills 35% + Experience 25%. */
const MATCH_EDUCATION_RANK = {
  Elementary: 1,
  Secondary: 2,
  "Senior High": 3,
  Tertiary: 4,
  "Graduate Studies": 5,
  "Post-graduate": 6,
};
const MATCH_WEIGHTS = { education: 0.4, skills: 0.35, experience: 0.25 };
const MATCH_REFERRAL_THRESHOLD = 70;

function matchClamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}
function matchEducationScore(seeker, job) {
  if (!seeker.education_level) return 0;
  const seekerRank = MATCH_EDUCATION_RANK[seeker.education_level] || 0;
  const requiredRank = MATCH_EDUCATION_RANK[job.min_education_level] || 0;
  if (!requiredRank) return 100;
  if (seekerRank >= requiredRank) return 100;
  return matchClamp((seekerRank / requiredRank) * 100);
}
function matchSkillsScore(seeker, job) {
  const requiredSkills = JSON.parse(job.required_skills || "[]");
  if (requiredSkills.length === 0) return 100;
  const seekerSkillsText = [
    seeker.skills || "",
    JSON.parse(seeker.other_skills || "[]").join(", "),
    seeker.technical_training || "",
    seeker.preferred_occupation1 || "",
    seeker.preferred_occupation2 || "",
  ]
    .join(" ")
    .toLowerCase();
  const matched = requiredSkills.filter((skill) => seekerSkillsText.includes(String(skill).toLowerCase()));
  return matchClamp((matched.length / requiredSkills.length) * 100);
}
function matchExtractYearsOfExperience(experienceText) {
  if (!experienceText) return 0;
  const match = experienceText.match(/(\d+(?:\.\d+)?)\s*\+?\s*(year|yr)/i);
  if (match) return parseFloat(match[1]);
  return experienceText.trim().length > 0 ? 0.5 : 0;
}
function matchExperienceScore(seeker, job) {
  const minYears = job.min_experience_years || 0;
  if (minYears <= 0) return 100;
  const years = matchExtractYearsOfExperience(seeker.experience || "");
  if (years >= minYears) return 100;
  return matchClamp((years / minYears) * 100);
}
/** Returns { educationScore, skillsScore, experienceScore, totalScore } (0-100, rounded),
 * mirroring the breakdown a Seeker sees on the frontend "Your Match Score" card. */
function computeServerMatchScore(seekerRow, vacancyRow) {
  const edu = matchEducationScore(seekerRow, vacancyRow);
  const skl = matchSkillsScore(seekerRow, vacancyRow);
  const exp = matchExperienceScore(seekerRow, vacancyRow);
  const total = edu * MATCH_WEIGHTS.education + skl * MATCH_WEIGHTS.skills + exp * MATCH_WEIGHTS.experience;
  return {
    educationScore: Math.round(edu),
    skillsScore: Math.round(skl),
    experienceScore: Math.round(exp),
    totalScore: Math.round(total),
  };
}

/* ================= ROUTES ================= */
const routes = [];
function route(method, pattern, handler) {
  // pattern like /api/applications/:id -> turn into a regex with named groups
  const paramNames = [];
  const regexStr = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  routes.push({ method, regex: new RegExp(`^${regexStr}$`), paramNames, handler });
}

/* ---- Auth ---- */
route("POST", "/api/auth/register", async (req, res) => {
  const body = await readJsonBody(req);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const confirmPassword = body.confirmPassword;
  const name = (body.name || "").trim();
  const createdAt = nowIso();
  const registrationExpiresAt = new Date(Date.now() + UNVERIFIED_ACCOUNT_TTL_MS).toISOString();
  // Only job_seeker and employer accounts may self-register. Staff and Admin
  // accounts are provisioned by an Admin (see POST /api/admin/staff).
  const role = ["job_seeker", "employer"].includes(body.role) ? body.role : "job_seeker";

  // Section 5: Gmail-only requirement, enforced on the BACKEND (never trust the
  // frontend's validation alone).
  if (!GMAIL_REGEX.test(email)) {
    return send(res, 400, { error: "Please use a valid Gmail address (@gmail.com)." });
  }
  if (!isStrongPassword(password)) {
    return send(res, 400, { error: PASSWORD_REQUIREMENTS_MESSAGE });
  }
  if (confirmPassword !== undefined && confirmPassword !== password) {
    return send(res, 400, { error: "Password and confirmation do not match." });
  }

  // Section 8: duplicate Gmail prevention.
  const existing = (await db.get("SELECT email FROM users WHERE email = ?", [email]));
  if (existing) return send(res, 409, { error: "This Gmail address is already registered. Please log in or use Forgot Password." });

  const { hash, salt } = hashPassword(password);
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationExpires = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString();

  try {
    await db.run(`
      INSERT INTO users (
        email, password_hash, password_salt, name, role, created_at,
        email_verified, email_verification_token, email_verification_expires, email_verification_last_sent,
        registration_expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `, [email, hash, salt, name, role, createdAt, verificationToken, verificationExpires, createdAt, registrationExpiresAt]);
  } catch (err) {
    // The primary key is global across roles; this also handles simultaneous
    // seeker/employer registration attempts that pass the pre-insert lookup.
    if (err.code === "ER_DUP_ENTRY" || err.errno === 1062) {
      return send(res, 409, { error: "This Gmail address is already registered. Please log in or use Forgot Password." });
    }
    throw err;
  }

  await logActivity({ userEmail: email, userRole: role, action: "user_registration", relatedRecord: email, performedBy: email, performedByRole: role });

  try {
    await sendVerificationEmail(email, verificationToken);
  } catch (err) {
    console.error("Failed to send verification email:", err.message);
  }

  // Section 6: the account is NOT activated and no session is issued until the
  // Gmail address is verified — the person must check their inbox first.
  send(res, 201, {
    requiresVerification: true,
    email,
    registrationExpiresAt,
    message: "Account created. Please check your Gmail inbox to verify your email address before logging in.",
  });
});

route("POST", "/api/auth/login", async (req, res) => {
  const body = await readJsonBody(req);
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const user = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return send(res, 401, { error: "Incorrect email or password." });
  }
  // Section 6: Job Seekers/Employers must verify their Gmail before logging in.
  if (!user.email_verified) {
    return send(res, 403, {
      error: "Please verify your Gmail address before logging in.",
      requiresVerification: true,
      email: user.email,
      registrationExpiresAt: user.registration_expires_at || "",
    });
  }
  const token = await createSession(email);
  send(res, 200, { token, user: serializeUser(user) });
});

/* Section 6/7: Gmail verification. */
route("POST", "/api/auth/verify-email", async (req, res) => {
  const body = await readJsonBody(req);
  const token = (body.token || "").trim();
  if (!token) return send(res, 400, { error: "Missing verification token." });

  const user = (await db.get("SELECT * FROM users WHERE email_verification_token = ?", [token]));
  if (!user) return send(res, 400, { error: "This verification link is invalid or has already been used." });
  if (new Date(user.email_verification_expires).getTime() < Date.now()) {
    return send(res, 400, { error: "This verification link has expired. Please request a new one." });
  }

  (await db.run(`
    UPDATE users SET email_verified = 1, email_verification_token = '', email_verification_expires = '',
      registration_expires_at = NULL
    WHERE email = ?
  `, [user.email]));
  await logActivity({ userEmail: user.email, userRole: user.role, action: "email_verified", relatedRecord: user.email });

  // Verifying logs the person straight in, so it isn't a dead end.
  const token2 = await createSession(user.email);
  const fresh = (await db.get("SELECT * FROM users WHERE email = ?", [user.email]));
  send(res, 200, { token: token2, user: serializeUser(fresh), message: "Email verified! You're now logged in." });
});

route("POST", "/api/auth/resend-verification", async (req, res) => {
  const body = await readJsonBody(req);
  const email = (body.email || "").trim().toLowerCase();
  // Generic response either way so this can't be used to enumerate accounts.
  const generic = { message: "If that account needs verification, a new email has been sent." };
  const user = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  if (!user || user.email_verified) return send(res, 200, generic);

  if (user.email_verification_last_sent) {
    const elapsed = Date.now() - new Date(user.email_verification_last_sent).getTime();
    if (elapsed < EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - elapsed) / 1000);
      return send(res, 429, { error: `Please wait ${waitSec}s before requesting another verification email.` });
    }
  }

  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationExpires = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString();
  (await db.run(`
    UPDATE users SET email_verification_token = ?, email_verification_expires = ?, email_verification_last_sent = ?
    WHERE email = ?
  `, [verificationToken, verificationExpires, nowIso(), email]));

  try {
    await sendVerificationEmail(email, verificationToken);
  } catch (err) {
    console.error("Failed to resend verification email:", err.message);
  }
  send(res, 200, generic);
});

/* Section 9/10: Forgot password / secure reset. */
route("POST", "/api/auth/forgot-password", async (req, res) => {
  const body = await readJsonBody(req);
  const email = (body.email || "").trim().toLowerCase();
  // Section 10: never reveal whether an account exists — always the same response.
  const generic = { message: "If an account is associated with this Gmail address, a password reset email has been sent." };
  const user = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  if (!user) return send(res, 200, generic);

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpires = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
  (await db.run(`
    UPDATE users SET password_reset_token = ?, password_reset_expires = ?, password_reset_used = 0
    WHERE email = ?
  `, [resetToken, resetExpires, email]));

  try {
    await sendPasswordResetEmail(email, resetToken);
  } catch (err) {
    console.error("Failed to send password reset email:", err.message);
  }
  send(res, 200, generic);
});

route("POST", "/api/auth/reset-password", async (req, res) => {
  const body = await readJsonBody(req);
  const token = (body.token || "").trim();
  const password = body.password || "";
  const confirmPassword = body.confirmPassword;
  if (!token) return send(res, 400, { error: "Missing reset token." });
  if (!isStrongPassword(password)) return send(res, 400, { error: PASSWORD_REQUIREMENTS_MESSAGE });
  if (confirmPassword !== undefined && confirmPassword !== password) {
    return send(res, 400, { error: "Password and confirmation do not match." });
  }

  const user = (await db.get("SELECT * FROM users WHERE password_reset_token = ?", [token]));
  if (!user || user.password_reset_used) {
    return send(res, 400, { error: "This reset link is invalid or has already been used." });
  }
  if (new Date(user.password_reset_expires).getTime() < Date.now()) {
    return send(res, 400, { error: "This reset link has expired. Please request a new one." });
  }

  const { hash, salt } = hashPassword(password);
  (await db.run(`
    UPDATE users SET password_hash = ?, password_salt = ?, password_reset_token = '', password_reset_expires = '', password_reset_used = 1
    WHERE email = ?
  `, [hash, salt, user.email]));
  // Invalidate every existing session — a password reset should log out any
  // other device/browser that had an active session with the old password.
  (await db.run("DELETE FROM sessions WHERE email = ?", [user.email]));
  await logActivity({ userEmail: user.email, userRole: user.role, action: "password_reset", relatedRecord: user.email });

  send(res, 200, { message: "Password successfully updated. Please log in with your new password." });
});

route("POST", "/api/auth/logout", async (req, res) => {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) (await db.run("DELETE FROM sessions WHERE token = ?", [token]));
  send(res, 200, { ok: true });
});

route("GET", "/api/auth/me", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  send(res, 200, { user: serializeUser(user) });
});

/** Public homepage stats — this is intentionally unauthenticated because the landing
 * page is visible to everyone, and the values are derived from the live database. */
route("GET", "/api/public/stats", async (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [openVacancies, partnerEmployers, placementsThisMonth] = await Promise.all([
    db.get(`SELECT COUNT(*) AS count FROM vacancies WHERE status = 'approved' AND ${PUBLIC_VACANCY_VALIDITY_SQL}`),
    db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'employer' AND verification_status = 'verified'"),
    db.get("SELECT COUNT(*) AS count FROM applications WHERE status = 'hired' AND date_applied >= ?", [monthStart.toISOString()]),
  ]);

  send(res, 200, {
    stats: {
      openVacancies: Number(openVacancies?.count || 0),
      placementsThisMonth: Number(placementsThisMonth?.count || 0),
      partnerEmployers: Number(partnerEmployers?.count || 0),
    },
  });
});

/* ---- Vacancies (public) — only APPROVED vacancies are ever visible to the public /
 * job seekers, per Section 9 (employer vacancies require Staff approval first). ---- */
route("GET", "/api/vacancies", async (req, res) => {
  await sweepExpiredVacancies();
  const rows = await db.all(`SELECT * FROM vacancies WHERE status = 'approved' AND ${PUBLIC_VACANCY_VALIDITY_SQL} ORDER BY LOWER(title), id`, []);
  send(res, 200, { vacancies: rows.map(serializeVacancy) });
});

route("GET", "/api/vacancies/:id", async (req, res, params) => {
  await sweepExpiredVacancies();
  const row = await db.get(`SELECT * FROM vacancies WHERE id = ? AND status = 'approved' AND ${PUBLIC_VACANCY_VALIDITY_SQL}`, [Number(params.id)]);
  if (!row) return send(res, 404, { error: "Vacancy not found." });
  send(res, 200, { vacancy: serializeVacancy(row) });
});

/* ---- Profile (Job Seeker) ---- */
route("GET", "/api/profile", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  send(res, 200, { profile: serializeUser(user), history: await getVerificationHistory(user.email) });
});

route("POST", "/api/profile/edit-request", async (req, res) => {
  const user = await requireRole(req, res, ["job_seeker", "employer"]);
  if (!user) return;
  if (!["verified", "rejected"].includes(user.verification_status)) {
    return send(res, 409, { error: "You can request another editing attempt only after your profile is verified or rejected." });
  }
  if (user.profile_edit_request_status === "pending") {
    return send(res, 409, { error: "Your request to edit this profile is already waiting for PESO Staff review." });
  }

  const body = await readJsonBody(req);
  const remarks = typeof body.remarks === "string" ? body.remarks.trim() : "";
  if (remarks.length > 1000) return send(res, 400, { error: "Your request note must be 1,000 characters or fewer." });

  const requestedAt = nowIso();
  const result = await db.run(`
    UPDATE users SET profile_edit_request_status = 'pending', profile_edit_request_remarks = ?, profile_edit_requested_at = ?
    WHERE email = ? AND verification_status IN ('verified', 'rejected') AND profile_edit_request_status != 'pending'
  `, [remarks, requestedAt, user.email]);
  if (!result.changes) {
    return send(res, 409, { error: "Your request could not be submitted. Refresh the profile and try again." });
  }
  const updated = await db.get("SELECT * FROM users WHERE email = ?", [user.email]);
  if (!updated || updated.profile_edit_request_status !== "pending" || updated.profile_edit_requested_at !== requestedAt) {
    return send(res, 409, { error: "Your request could not be submitted. Refresh the profile and try again." });
  }

  await logVerification({
    userEmail: user.email, userRole: user.role, previousStatus: user.verification_status,
    newStatus: user.verification_status, action: "profile_edit_requested", remarks,
    performedBy: user.email, performedByRole: user.role,
  });
  await logActivity({
    userEmail: user.email, userRole: user.role, action: "profile_edit_requested",
    relatedRecord: user.email, performedBy: user.email, performedByRole: user.role, remarks,
  });
  await notify(user.email, "Your request to edit your profile has been sent to PESO Staff for review.");
  const staffAccounts = await db.all("SELECT email FROM users WHERE role IN ('staff', 'admin') AND email_verified = 1");
  await Promise.all(staffAccounts.map((account) => notify(account.email, `${user.role === "employer" ? "Employer" : "Job Seeker"} ${user.name || user.email} requested permission to edit their profile.`)));
  send(res, 200, { profile: serializeUser(updated) });
});

route("GET", "/api/profile/avatar", async (req, res) => {
  const user = await requireAnyAuth(req, res);
  if (!user) return;
  send(res, 200, { avatarData: user.avatar_data || "" });
});

route("PUT", "/api/profile/avatar", async (req, res) => {
  const user = await requireAnyAuth(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const match = typeof body.avatarData === "string"
    ? body.avatarData.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/)
    : null;
  if (!match) return send(res, 400, { error: "Please upload a valid JPEG profile photo." });

  const image = Buffer.from(match[1], "base64");
  if (image.length > MAX_AVATAR_BYTES) return send(res, 413, { error: "Profile photos must be smaller than 1 MB." });
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
    return send(res, 400, { error: "The uploaded file is not a valid JPEG image." });
  }

  const avatarData = `data:image/jpeg;base64,${image.toString("base64")}`;
  await db.run("UPDATE users SET avatar_data = ? WHERE email = ?", [avatarData, user.email]);
  send(res, 200, { avatarData });
});

route("PUT", "/api/profile", async (req, res) => {
  const user = await requireRole(req, res, ["job_seeker"]);
  if (!user) return;
  // Rule 2 / Rule 7: a Pending Verification or Verified profile cannot be edited —
  // only Draft (never submitted) or Returned for Completion can be. Enforced here on
  // the backend regardless of what the frontend form sends.
  if (!["draft", "returned_for_completion"].includes(user.verification_status)) {
    return send(res, 423, { error: "Your profile is locked while it is pending or has already been verified, and cannot be edited right now." });
  }
  const b = await readJsonBody(req);

  const fields = {
    surname: b.surname, first_name: b.firstName, middle_name: b.middleName, suffix: b.suffix,
    date_of_birth: b.dateOfBirth, sex: b.sex, religion: b.religion, civil_status: b.civilStatus,
    house_street: b.houseStreet, barangay: b.barangay, municipality: b.municipality, province: b.province,
    tin: b.tin, height_ft: b.heightFt,
    contact_number: b.contactNumber,
    disability_types: JSON.stringify(b.disabilityTypes || []), disability_others: b.disabilityOthers,
    employment_status: b.employmentStatus,
    employment_sub_type: b.employmentSubType, employment_sub_type_others: b.employmentSubTypeOthers,
    months_looking_for_work: b.monthsLookingForWork,
    job_seeker_category: JSON.stringify(b.jobSeekerCategory || []),
    terminated_abroad_country: b.terminatedAbroadCountry, job_seeker_category_others: b.jobSeekerCategoryOthers,
    is_ofw: b.isOFW, ofw_country: b.ofwCountry, ofw_return_date: b.ofwReturnDate,
    is_4ps: b.is4Ps, household_id_no: b.householdIdNo,
    preferred_occupation1: b.preferredOccupation1, preferred_occupation2: b.preferredOccupation2,
    work_type: b.workType, work_location: b.workLocation,
    preferred_local_areas: JSON.stringify(b.preferredLocalAreas || []),
    preferred_overseas_countries: JSON.stringify(b.preferredOverseasCountries || []),
    language_proficiency: JSON.stringify(b.languageProficiency || {}),
    currently_in_school: b.currentlyInSchool,
    education_level: b.educationLevel, course: b.course, year_graduated: b.yearGraduated,
    undergrad_level_reached: b.undergradLevelReached, undergrad_year_last_attended: b.undergradYearLastAttended,
    trainings: JSON.stringify(b.trainings || []),
    eligibilities: JSON.stringify(b.eligibilities || []),
    licenses: JSON.stringify(b.licenses || []),
    technical_training: b.technicalTraining, other_skills: JSON.stringify(b.otherSkills || []),
    other_skills_custom: b.otherSkillsCustom, skills: b.skills,
    company_name: b.companyName, position: b.position, experience: b.experience,
    work_experiences: JSON.stringify(b.workExperiences || []),
    referred_to: JSON.stringify(b.referredTo || []), referred_to_others: b.referredToOthers,
    application_type: b.applicationType || "New Applicant",
    no_documents_declared: b.noDocumentsDeclared,
  };
  const name = `${b.firstName || ""} ${b.surname || ""}`.trim() || user.name;

  const setClause = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  (await db.run(`UPDATE users SET ${setClause}, name = ? WHERE email = ?`, [...Object.values(fields).map((v) => (v === undefined ? "" : v)), name, user.email,]));

  const updated = (await db.get("SELECT * FROM users WHERE email = ?", [user.email]));
  send(res, 200, { profile: serializeUser(updated) });
});

/** Job Seeker clicks "Submit for Verification" / "Resubmit for Verification".
 * Rule 1 / Rule 8: the profile is locked and status becomes Pending Verification. */
route("POST", "/api/profile/submit", async (req, res) => {
  const user = await requireRole(req, res, ["job_seeker"]);
  if (!user) return;
  if (!["draft", "returned_for_completion"].includes(user.verification_status)) {
    return send(res, 409, { error: "Your profile has already been submitted and is awaiting PESO Staff review." });
  }
  const docCount = (await db.get("SELECT COUNT(*) AS c FROM documents WHERE email = ?", [user.email])).c;
  const profile = serializeUser(user);
  if (!isProfileComplete(profile, docCount)) {
    return send(res, 422, { error: "Please complete every required field (and attach your documents, or mark None) before submitting for verification." });
  }
  const wasReturned = user.verification_status === "returned_for_completion";
  (await db.run(`
    UPDATE users SET verification_status = 'pending_verification', verification_remarks = '',
      profile_edit_request_status = 'none', profile_edit_request_remarks = '', profile_edit_requested_at = '',
      verification_submitted_at = ?, verification_attempts = verification_attempts + 1
    WHERE email = ?
  `, [nowIso(), user.email]));

  await logVerification({
    userEmail: user.email, userRole: "job_seeker", previousStatus: user.verification_status,
    newStatus: "pending_verification", action: wasReturned ? "resubmitted" : "profile_submitted",
    remarks: wasReturned ? "Job Seeker resubmitted after completing missing information." : "Initial submission.",
    performedBy: user.email, performedByRole: "job_seeker",
  });
  await logActivity({ userEmail: user.email, userRole: "job_seeker", action: wasReturned ? "profile_resubmission" : "profile_submission", relatedRecord: user.email, performedBy: user.email, performedByRole: "job_seeker" });
  await notify(user.email, "Your profile has been submitted successfully and is now waiting for verification by PESO Staff.");

  const updated = (await db.get("SELECT * FROM users WHERE email = ?", [user.email]));
  send(res, 200, { profile: serializeUser(updated) });
});

/* ---- Employer profile ---- */
route("GET", "/api/employer/profile", async (req, res) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  send(res, 200, { profile: serializeUser(user), history: await getVerificationHistory(user.email) });
});

route("PUT", "/api/employer/profile", async (req, res) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  // Pending review, verified, rejected, and suspended profiles require Staff permission.
  if (!["draft", "returned_for_completion"].includes(user.verification_status)) {
    return send(res, 423, { error: "Your employer profile is locked while it is pending review, verified, rejected, or suspended. Request another editing attempt from PESO Staff to make changes." });
  }
  const b = await readJsonBody(req);
  const fields = {
    employer_business_name: b.employerBusinessName, employer_trade_name: b.employerTradeName,
    employer_acronym: b.employerAcronym, employer_tin: b.employerTin,
    employer_type: b.employerType, employer_category: b.employerCategory,
    employer_nature_of_work: b.employerNatureOfWork, employer_workforce_size: b.employerWorkforceSize,
    employer_industry: b.employerIndustry,
    employer_street: b.employerStreet, employer_barangay: b.employerBarangay,
    employer_municipality: b.employerMunicipality, employer_province: b.employerProvince,
    employer_owner_name: b.employerOwnerName, employer_contact_person: b.employerContactPerson,
    employer_position: b.employerPosition, employer_telephone: b.employerTelephone,
    employer_mobile: b.employerMobile, employer_fax: b.employerFax, employer_email: b.employerEmail,
    employer_description: b.employerDescription,
    // Legacy fields kept in sync so existing display code (vacancy employer name,
    // staff/admin list rows, address string) keeps working without changes.
    employer_company_name: b.employerBusinessName,
    employer_address: [b.employerStreet, b.employerBarangay, b.employerMunicipality, b.employerProvince].filter(Boolean).join(", "),
    employer_contact_number: b.employerMobile,
  };
  const name = b.employerBusinessName || user.name;

  const setClause = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  (await db.run(`UPDATE users SET ${setClause}, name = ? WHERE email = ?`, [...Object.values(fields).map((v) => (v === undefined ? "" : v)), name, user.email,]));
  await logActivity({ userEmail: user.email, userRole: "employer", action: "employer_profile_update", relatedRecord: user.email, performedBy: user.email, performedByRole: "employer" });

  const updated = (await db.get("SELECT * FROM users WHERE email = ?", [user.email]));
  send(res, 200, { profile: serializeUser(updated) });
});

route("POST", "/api/employer/profile/submit", async (req, res) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  if (!["draft", "returned_for_completion"].includes(user.verification_status)) {
    return send(res, 409, { error: "Your employer profile has already been submitted and is awaiting PESO Staff review." });
  }
  if (!isEmployerProfileComplete(serializeUser(user))) {
    return send(res, 422, { error: "Please complete every required establishment field before submitting for verification." });
  }
  const wasReturned = user.verification_status === "returned_for_completion";
  (await db.run(`
    UPDATE users SET verification_status = 'pending_verification', verification_remarks = '',
      profile_edit_request_status = 'none', profile_edit_request_remarks = '', profile_edit_requested_at = '',
      verification_submitted_at = ?, verification_attempts = verification_attempts + 1
    WHERE email = ?
  `, [nowIso(), user.email]));

  await logVerification({
    userEmail: user.email, userRole: "employer", previousStatus: user.verification_status,
    newStatus: "pending_verification", action: wasReturned ? "resubmitted" : "profile_submitted",
    remarks: wasReturned ? "Employer resubmitted after completing missing information." : "Initial submission.",
    performedBy: user.email, performedByRole: "employer",
  });
  await logActivity({ userEmail: user.email, userRole: "employer", action: wasReturned ? "employer_resubmission" : "employer_verification_submission", relatedRecord: user.email, performedBy: user.email, performedByRole: "employer" });
  await notify(user.email, "Your establishment information has been submitted successfully and is now waiting for verification by PESO Staff.");

  const updated = (await db.get("SELECT * FROM users WHERE email = ?", [user.email]));
  send(res, 200, { profile: serializeUser(updated) });
});

/* ---- Employer vacancies ---- */
route("GET", "/api/employer/vacancies", async (req, res) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  await sweepExpiredVacancies();
  const rows = (await db.all("SELECT * FROM vacancies WHERE employer_email = ? ORDER BY LOWER(title), id", [user.email]));
  send(res, 200, { vacancies: rows.map(serializeVacancy) });
});

route("GET", "/api/employer/location-search", async (req, res, params, url) => {
  if (!await requireRole(req, res, ["employer"])) return;
  const query = (url.searchParams.get("q") || "").trim();
  if (query.length < 2 || query.length > 100) return send(res, 400, { error: "Enter a location between 2 and 100 characters long." });
  const cacheKey = query.toLocaleLowerCase();
  if (locationSearchCache.has(cacheKey)) return send(res, 200, { locations: locationSearchCache.get(cacheKey) });

  const search = nominatimQueue.then(async () => {
    const delay = Math.max(0, 1000 - (Date.now() - lastNominatimRequestAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastNominatimRequestAt = Date.now();
    const searchUrl = new URL("https://nominatim.openstreetmap.org/search");
    searchUrl.search = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      limit: "8",
      countrycodes: "ph",
      q: `${query}, Gingoog City, Misamis Oriental, Philippines`,
    }).toString();
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "PESO-Gingoog-Employment-System/1.0",
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenStreetMap location search returned HTTP ${response.status}.`);
    const results = await response.json();
    const locations = results
      .filter((item) => item.display_name?.toLocaleLowerCase().includes("gingo") && item.lat && item.lon)
      .map((item) => ({ label: item.display_name, latitude: Number(item.lat), longitude: Number(item.lon) }))
      .filter((item) => Number.isFinite(item.latitude) && item.latitude >= -90 && item.latitude <= 90
        && Number.isFinite(item.longitude) && item.longitude >= -180 && item.longitude <= 180);
    if (locationSearchCache.size >= 250) locationSearchCache.delete(locationSearchCache.keys().next().value);
    locationSearchCache.set(cacheKey, locations);
    return locations;
  });
  nominatimQueue = search.then(() => undefined, () => undefined);
  try {
    send(res, 200, { locations: await search });
  } catch (error) {
    console.error("Could not search OpenStreetMap locations:", error);
    send(res, 502, { error: "Location search is temporarily unavailable. Please try again." });
  }
});

route("GET", "/api/employer/location-reverse", async (req, res, params, url) => {
  if (!await requireRole(req, res, ["employer"])) return;
  const latitude = Number(url.searchParams.get("lat"));
  const longitude = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return send(res, 400, { error: "Select a valid map location." });
  }
  const cacheKey = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  if (locationReverseCache.has(cacheKey)) return send(res, 200, { location: locationReverseCache.get(cacheKey) });

  const reverseSearch = nominatimQueue.then(async () => {
    const delay = Math.max(0, 1000 - (Date.now() - lastNominatimRequestAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastNominatimRequestAt = Date.now();
    const reverseUrl = new URL("https://nominatim.openstreetmap.org/reverse");
    reverseUrl.search = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      zoom: "18",
      lat: String(latitude),
      lon: String(longitude),
    }).toString();
    const response = await fetch(reverseUrl, {
      headers: {
        "User-Agent": "PESO-Gingoog-Employment-System/1.0",
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenStreetMap reverse search returned HTTP ${response.status}.`);
    const result = await response.json();
    if (!result.display_name?.toLocaleLowerCase().includes("gingo")) {
      const error = new Error("Choose a map location within Gingoog City.");
      error.statusCode = 422;
      throw error;
    }
    return { label: result.display_name, latitude, longitude };
  });
  nominatimQueue = reverseSearch.then(() => undefined, () => undefined);
  try {
    const location = await reverseSearch;
    if (locationReverseCache.size >= 500) locationReverseCache.delete(locationReverseCache.keys().next().value);
    locationReverseCache.set(cacheKey, location);
    send(res, 200, { location });
  } catch (error) {
    if (error.statusCode === 422) return send(res, 422, { error: error.message });
    console.error("Could not reverse-search OpenStreetMap location:", error);
    send(res, 502, { error: "Could not find an address for this map pin. Try another location." });
  }
});

/** Employers can Save as Draft (no PESO involvement yet) or Submit directly for
 * approval (Section 4 / Section 9). Draft vacancies aren't validated as strictly —
 * a Job Title is enough to save progress — but submitting requires every required
 * Vacancy Details / Qualification Requirements field the NSRP Form 2 asks for. */
route("POST", "/api/employer/vacancies", async (req, res) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  if (user.verification_status !== "verified") {
    return send(res, 403, { error: "Your establishment must be verified by PESO Staff before you can create job vacancies." });
  }
  const b = await readJsonBody(req);
  const isDraft = !!b.isDraft;
  if (isMissingVacancyValue(b.title)) return send(res, 400, { error: "Enter a valid Position Title." });
  const title = String(b.title).trim();
  const expiryDays = b.expiryDays === undefined ? 5 : Number(b.expiryDays);
  if (!isValidVacancyExpiryDays(expiryDays)) {
    return send(res, 400, { error: "Choose a vacancy expiry period between 2 and 5 days." });
  }
  const hasCoordinates = b.latitude !== undefined && b.latitude !== null && b.longitude !== undefined && b.longitude !== null;
  const validCoordinates = hasCoordinates && Number.isFinite(Number(b.latitude)) && Number.isFinite(Number(b.longitude))
    && Number(b.latitude) >= -90 && Number(b.latitude) <= 90
    && Number(b.longitude) >= -180 && Number(b.longitude) <= 180;
  if (((b.latitude !== undefined && b.latitude !== null) || (b.longitude !== undefined && b.longitude !== null)) && !validCoordinates) {
    return send(res, 400, { error: "Please select a valid location on the map." });
  }
  if (!isDraft) {
    const required = ["title", "category", "location", "salary", "type", "slots", "description", "minEducationLevel", "minExperienceYears"];
    for (const f of required) {
      if (isMissingVacancyValue(b[f])) {
        return send(res, 400, { error: `Missing required field: ${f}` });
      }
    }
    if (!validCoordinates) return send(res, 400, { error: "Please select the job location on the map before submitting." });
  }
  const result = (await db.run(`
    INSERT INTO vacancies
      (title, employer, category, location, salary, type, slots, posted, qualification, description,
       min_education_level, required_skills, min_experience_years, employer_email, status, latitude, longitude,
       work_experience, other_qualifications, accepts_pwd, pwd_types, accepts_returning_ofw,
       course_shs_strand, license, certification, eligibility, language_dialect, valid_until, expiry_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [title, user.employer_business_name || user.employer_company_name || user.name, b.category || "", b.location || "",
    b.salary || "", b.type || "", Number(b.slots) || 1, nowIso(), JSON.stringify(b.qualification || []), b.description || "",
    b.minEducationLevel || "", JSON.stringify(b.requiredSkills || []), Number(b.minExperienceYears) || 0, user.email,
    isDraft ? "draft" : "pending_approval", validCoordinates ? Number(b.latitude) : null, validCoordinates ? Number(b.longitude) : null,
    b.workExperience || "", b.otherQualifications || "", b.acceptsPwd || "", JSON.stringify(b.pwdTypes || []),
    b.acceptsReturningOfw || "", b.courseShsStrand || "", b.license || "", b.certification || "", b.eligibility || "",
    b.languageDialect || "", vacancyExpiryDate(expiryDays), expiryDays,]));
  await logActivity({ userEmail: user.email, userRole: "employer", action: isDraft ? "job_vacancy_draft_created" : "job_vacancy_submission", relatedRecord: `vacancy #${result.lastInsertRowid}`, performedBy: user.email, performedByRole: "employer" });
  if (!isDraft) await notify(user.email, `Your job vacancy "${b.title}" has been submitted and is now pending PESO approval.`);
  const row = (await db.get("SELECT * FROM vacancies WHERE id = ?", [result.lastInsertRowid]));
  send(res, 201, { vacancy: serializeVacancy(row) });
});

route("PUT", "/api/employer/vacancies/:id", async (req, res, params) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  const vac = (await db.get("SELECT * FROM vacancies WHERE id = ? AND employer_email = ?", [Number(params.id), user.email]));
  if (!vac) return send(res, 404, { error: "Vacancy not found." });
  if (!["draft", "returned_for_completion", "rejected"].includes(vac.status)) {
    return send(res, 423, { error: "This vacancy can't be edited in its current status." });
  }
  const b = await readJsonBody(req);
  const title = b.title ?? vac.title;
  if (isMissingVacancyValue(title)) return send(res, 400, { error: "Enter a valid Position Title." });
  const expiryDays = b.expiryDays === undefined
    ? (isValidVacancyExpiryDays(vac.expiry_days) ? Number(vac.expiry_days) : 5)
    : Number(b.expiryDays);
  if (!isValidVacancyExpiryDays(expiryDays)) {
    return send(res, 400, { error: "Choose a vacancy expiry period between 2 and 5 days." });
  }
  const latitude = b.latitude === undefined ? vac.latitude : b.latitude;
  const longitude = b.longitude === undefined ? vac.longitude : b.longitude;
  const hasCoordinates = latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined;
  const validCoordinates = hasCoordinates && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
    && Number(latitude) >= -90 && Number(latitude) <= 90
    && Number(longitude) >= -180 && Number(longitude) <= 180;
  if ((latitude !== null && latitude !== undefined || longitude !== null && longitude !== undefined) && !validCoordinates) {
    return send(res, 400, { error: "Please select a valid location on the map." });
  }
  (await db.run(`
    UPDATE vacancies SET title=?, category=?, location=?, salary=?, type=?, slots=?, qualification=?,
      description=?, min_education_level=?, required_skills=?, min_experience_years=?,
      latitude=?, longitude=?,
      work_experience=?, other_qualifications=?, accepts_pwd=?, pwd_types=?, accepts_returning_ofw=?,
      course_shs_strand=?, license=?, certification=?, eligibility=?, language_dialect=?, valid_until=?, expiry_days=?
    WHERE id = ?
  `, [String(title).trim(), b.category ?? vac.category, b.location ?? vac.location, b.salary ?? vac.salary,
    b.type ?? vac.type, Number(b.slots) || vac.slots, JSON.stringify(b.qualification || JSON.parse(vac.qualification)),
    b.description ?? vac.description, b.minEducationLevel ?? vac.min_education_level,
    JSON.stringify(b.requiredSkills || JSON.parse(vac.required_skills)), Number(b.minExperienceYears) || vac.min_experience_years,
    validCoordinates ? Number(latitude) : null, validCoordinates ? Number(longitude) : null,
    b.workExperience ?? vac.work_experience, b.otherQualifications ?? vac.other_qualifications,
    b.acceptsPwd ?? vac.accepts_pwd, JSON.stringify(b.pwdTypes || JSON.parse(vac.pwd_types || "[]")),
    b.acceptsReturningOfw ?? vac.accepts_returning_ofw, b.courseShsStrand ?? vac.course_shs_strand,
    b.license ?? vac.license, b.certification ?? vac.certification, b.eligibility ?? vac.eligibility,
    b.languageDialect ?? vac.language_dialect, vacancyExpiryDate(expiryDays), expiryDays,
    vac.id,]));
  await logActivity({ userEmail: user.email, userRole: "employer", action: "job_vacancy_editing", relatedRecord: `vacancy #${vac.id}`, performedBy: user.email, performedByRole: "employer" });
  const row = (await db.get("SELECT * FROM vacancies WHERE id = ?", [vac.id]));
  send(res, 200, { vacancy: serializeVacancy(row) });
});

/** Submit a Draft (or previously Returned/Rejected) vacancy for PESO approval. */
route("POST", "/api/employer/vacancies/:id/submit", async (req, res, params) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  const vac = (await db.get("SELECT * FROM vacancies WHERE id = ? AND employer_email = ?", [Number(params.id), user.email]));
  if (!vac) return send(res, 404, { error: "Vacancy not found." });
  if (!["draft", "returned_for_completion", "rejected"].includes(vac.status)) {
    return send(res, 409, { error: "This vacancy is not in a submittable status." });
  }
  const required = ["title", "category", "location", "salary", "type", "description"];
  for (const f of required) {
    const col = { title: "title", category: "category", location: "location", salary: "salary", type: "type", description: "description" }[f];
    if (isMissingVacancyValue(vac[col])) return send(res, 422, { error: `Please complete "${f}" before submitting this vacancy for approval.` });
  }
  if (vac.latitude === null || vac.latitude === undefined || vac.longitude === null || vac.longitude === undefined
    || !Number.isFinite(Number(vac.latitude)) || !Number.isFinite(Number(vac.longitude))
    || Number(vac.latitude) < -90 || Number(vac.latitude) > 90
    || Number(vac.longitude) < -180 || Number(vac.longitude) > 180) {
    return send(res, 422, { error: "Please select the job location on the map before submitting this vacancy for approval." });
  }
  const expiryDays = Number(vac.expiry_days) || 5;
  if (!isValidVacancyExpiryDays(expiryDays)) return send(res, 422, { error: "The vacancy expiry period must be between 2 and 5 days before submission." });
  (await db.run("UPDATE vacancies SET status = 'pending_approval', remarks = '', posted = ?, valid_until = ? WHERE id = ?", [nowIso(), vacancyExpiryDate(expiryDays), vac.id]));
  await logActivity({ userEmail: user.email, userRole: "employer", action: vac.status === "draft" ? "job_vacancy_submission" : "job_vacancy_resubmission", relatedRecord: `vacancy #${vac.id}`, performedBy: user.email, performedByRole: "employer" });
  await notify(user.email, `Your job vacancy "${vac.title}" has been submitted and is now pending PESO approval.`);
  const row = (await db.get("SELECT * FROM vacancies WHERE id = ?", [vac.id]));
  send(res, 200, { vacancy: serializeVacancy(row) });
});

/** Close a vacancy — e.g. the position was filled. Employer-initiated, doesn't need
 * PESO approval, but is logged for the audit trail. */
route("POST", "/api/employer/vacancies/:id/close", async (req, res, params) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  const vac = (await db.get("SELECT * FROM vacancies WHERE id = ? AND employer_email = ?", [Number(params.id), user.email]));
  if (!vac) return send(res, 404, { error: "Vacancy not found." });
  if (!["approved", "expired"].includes(vac.status)) {
    return send(res, 409, { error: "Only an approved or expired vacancy can be closed." });
  }
  (await db.run("UPDATE vacancies SET status = 'closed' WHERE id = ?", [vac.id]));
  await logActivity({ userEmail: user.email, userRole: "employer", action: "job_vacancy_closure", relatedRecord: `vacancy #${vac.id}`, performedBy: user.email, performedByRole: "employer" });
  const row = (await db.get("SELECT * FROM vacancies WHERE id = ?", [vac.id]));
  send(res, 200, { vacancy: serializeVacancy(row) });
});

route("POST", "/api/employer/vacancies/:id/repost", async (req, res, params) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  const vac = await db.get("SELECT * FROM vacancies WHERE id = ? AND employer_email = ?", [Number(params.id), user.email]);
  if (!vac) return send(res, 404, { error: "Vacancy not found." });
  if (!["expired", "closed"].includes(vac.status)) {
    return send(res, 409, { error: "Only a closed or expired vacancy can be reposted." });
  }
  const required = ["title", "category", "location", "salary", "type", "description"];
  for (const field of required) {
    if (isMissingVacancyValue(vac[field])) {
      return send(res, 422, { error: `This vacancy needs a valid ${field} before it can be reposted.` });
    }
  }
  if (vac.latitude === null || vac.latitude === undefined || vac.longitude === null || vac.longitude === undefined
    || !Number.isFinite(Number(vac.latitude)) || !Number.isFinite(Number(vac.longitude))
    || Number(vac.latitude) < -90 || Number(vac.latitude) > 90
    || Number(vac.longitude) < -180 || Number(vac.longitude) > 180) {
    return send(res, 422, { error: "This vacancy needs a valid map location before it can be reposted." });
  }
  const expiryDays = Number(vac.expiry_days);
  if (!isValidVacancyExpiryDays(expiryDays)) {
    return send(res, 422, { error: "Choose a vacancy duration between 2 and 5 days before reposting." });
  }

  const created = await db.run(`
    INSERT INTO vacancies (
      title, employer, category, location, salary, type, slots, posted, qualification,
      description, min_education_level, required_skills, min_experience_years,
      employer_email, status, latitude, longitude, work_experience, other_qualifications,
      accepts_pwd, pwd_types, accepts_returning_ofw, course_shs_strand, license,
      certification, eligibility, language_dialect, valid_until, expiry_days
    )
    SELECT
      title, employer, category, location, salary, type, slots, ?, qualification,
      description, min_education_level, required_skills, min_experience_years,
      employer_email, 'pending_approval', latitude, longitude, work_experience,
      other_qualifications, accepts_pwd, pwd_types, accepts_returning_ofw,
      course_shs_strand, license, certification, eligibility, language_dialect, ?, ?
    FROM vacancies
    WHERE id = ? AND employer_email = ? AND status IN ('expired', 'closed')
  `, [nowIso(), vacancyExpiryDate(expiryDays), expiryDays, vac.id, user.email]);
  if (!created.changes) return send(res, 409, { error: "This vacancy is no longer available to repost." });

  const newVacancyId = created.lastInsertRowid;
  await logActivity({
    userEmail: user.email,
    userRole: "employer",
    action: "job_vacancy_reposted",
    relatedRecord: `vacancy #${newVacancyId}`,
    performedBy: user.email,
    performedByRole: "employer",
    remarks: `Reposted from vacancy #${vac.id}`,
  });
  await notify(user.email, `Your reposted job vacancy "${vac.title}" has been submitted as a new listing and is pending PESO approval.`);
  const row = await db.get("SELECT * FROM vacancies WHERE id = ?", [newVacancyId]);
  send(res, 201, { vacancy: serializeVacancy(row) });
});

/** Section 27/28: Job Seekers apply DIRECTLY to Employers — there is no PESO Staff
 * referral step in between. Every application for one of an employer's vacancies is
 * visible to that employer immediately. Includes the seeker info an employer is
 * permitted to see, plus their computed match score as a "qualification summary". */
route("GET", "/api/employer/applications", async (req, res) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  const rows = (await db.all(`
    SELECT a.*, u.name AS seeker_name, u.contact_number AS seeker_contact, u.skills AS seeker_skills,
           u.education_level AS seeker_education, u.course AS seeker_course, u.experience AS seeker_experience,
           v.title AS vacancy_title
    FROM applications a
    JOIN users u ON u.email = a.email
    JOIN vacancies v ON v.id = a.vacancy_id
    WHERE v.employer_email = ?
    ORDER BY a.id DESC
  `, [user.email]));
  send(res, 200, {
    applications: rows.map((r) => ({
      ...serializeApplication(r),
      seekerName: r.seeker_name,
      seekerContact: r.seeker_contact,
      seekerSkills: r.seeker_skills,
      seekerEducation: r.seeker_education,
      seekerCourse: r.seeker_course,
      seekerExperience: r.seeker_experience,
      vacancyTitle: r.vacancy_title,
    })),
  });
});

/** Employer — View full Seeker Profile for one of their own applicants. Reuses the same
 * `users`/`documents` data already collected on the seeker's account (no duplicate profile
 * data is created or stored). Scoped strictly to applications for the requesting employer's
 * own vacancies — an employer can never look up an arbitrary seeker by email. */
route("GET", "/api/employer/applications/:id/seeker", async (req, res, params) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  const app = (await db.get(`
    SELECT a.*, seeker.name AS seeker_name, v.employer_email, v.title AS vacancy_title FROM applications a
    JOIN users seeker ON seeker.email = a.email
    JOIN vacancies v ON v.id = a.vacancy_id WHERE a.id = ?
  `, [Number(params.id)]));
  if (!app || app.employer_email !== user.email) return send(res, 404, { error: "Application not found." });
  const seekerRow = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'job_seeker'", [app.email]));
  if (!seekerRow) return send(res, 404, { error: "Seeker profile not found." });
  send(res, 200, {
    profile: serializeUser(seekerRow),
    documents: (await db.all("SELECT * FROM documents WHERE email = ? ORDER BY id DESC", [app.email])).map(serializeDocument),
    vacancyTitle: app.vacancy_title,
  });
});

/** Section 28/29: the Employer reviews the application and decides — Staff is never
 * consulted or required. The top-level `status` (what the Job Seeker sees) is derived
 * automatically from the Employer's decision so the seeker's status page stays in sync
 * without Staff having to do anything (Section 30/31: Staff only MONITORS the outcome). */
const EMPLOYER_APPLICATION_STATUSES = ["under_employer_review", "shortlisted", "interview", "accepted_hired", "not_selected"];
const EMPLOYER_STATUS_TO_SEEKER_STATUS = {
  under_employer_review: { status: "checking", label: "Employer is reviewing your application" },
  shortlisted: { status: "waiting", label: "Waiting for employer's decision" },
  interview: { status: "waiting", label: "Waiting for employer's decision" },
  accepted_hired: { status: "hired", label: "Hired! Congratulations" },
  not_selected: { status: "declined", label: "Not selected this time" },
};
route("PATCH", "/api/employer/applications/:id", async (req, res, params) => {
  const user = await requireRole(req, res, ["employer"]);
  if (!user) return;
  const app = (await db.get(`
    SELECT a.*, seeker.name AS seeker_name, v.employer_email, v.title AS vacancy_title FROM applications a
    JOIN users seeker ON seeker.email = a.email
    JOIN vacancies v ON v.id = a.vacancy_id WHERE a.id = ?
  `, [Number(params.id)]));
  if (!app || app.employer_email !== user.email) return send(res, 404, { error: "Application not found." });
  const b = await readJsonBody(req);
  if (!EMPLOYER_APPLICATION_STATUSES.includes(b.employerStatus)) return send(res, 400, { error: "Invalid status." });

  const mapped = EMPLOYER_STATUS_TO_SEEKER_STATUS[b.employerStatus];
  const history = JSON.parse(app.history);
  if (history[history.length - 1]?.label !== mapped.label) history.push({ label: mapped.label, date: today() });
  (await db.run("UPDATE applications SET employer_status = ?, employer_remarks = ?, status = ?, history = ? WHERE id = ?", [b.employerStatus, b.remarks || "", mapped.status, JSON.stringify(history), app.id]));

  await logActivity({ userEmail: app.email, userRole: "job_seeker", action: "employer_application_decision", relatedRecord: `application #${app.id}`, performedBy: user.email, performedByRole: "employer", remarks: b.employerStatus });
  const isNewHire = b.employerStatus === "accepted_hired" && app.employer_status !== "accepted_hired";
  await notify(
    app.email,
    isNewHire
      ? `Congratulations! You have been marked as hired for ${app.vacancy_title}. Please proceed to the PESO office to claim your referral letter.`
      : `${user.employer_business_name || user.name} updated your application for ${app.vacancy_title}: ${mapped.label}.`,
  );
  if (isNewHire) {
    const staffAccounts = await db.all("SELECT email FROM users WHERE role = 'staff' AND email_verified = 1");
    for (const staffAccount of staffAccounts) {
      await notify(staffAccount.email, `${app.seeker_name || app.email} was marked as hired for ${app.vacancy_title} at ${user.employer_business_name || user.name}. Please contact the seeker to arrange collection of their PESO referral letter.`);
    }
  }
  const updated = (await db.get("SELECT * FROM applications WHERE id = ?", [app.id]));
  send(res, 200, { application: serializeApplication(updated) });
});

/* ---- Applications (Job Seeker) ---- */
route("GET", "/api/applications", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  const rows = (await db.all("SELECT * FROM applications WHERE email = ? ORDER BY id DESC", [user.email]));
  send(res, 200, { applications: rows.map(serializeApplication) });
});

route("POST", "/api/applications", async (req, res) => {
  const user = await requireRole(req, res, ["job_seeker"]);
  if (!user) return;
  // Rule 3 / Rule 4 / Rule 9: only a VERIFIED job seeker profile can apply for jobs.
  if (user.verification_status !== "verified") {
    return send(res, 403, { error: "Your profile must be verified by PESO Staff before job matching and job applications become available." });
  }
  const docCount = (await db.get("SELECT COUNT(*) AS c FROM documents WHERE email = ?", [user.email])).c;
  if (!isProfileComplete(serializeUser(user), docCount)) {
    return send(res, 422, { error: "Please complete your Jobseeker Profile (NSRP Form) before applying." });
  }
  const b = await readJsonBody(req);
  const vacancyId = Number(b.vacancyId);
  const vacancy = (await db.get("SELECT * FROM vacancies WHERE id = ? AND status = 'approved'", [vacancyId]));
  if (!vacancy) return send(res, 404, { error: "Vacancy not found." });

  const dup = (await db.get("SELECT id FROM applications WHERE email = ? AND vacancy_id = ?", [user.email, vacancyId]));
  if (dup) return send(res, 409, { error: "You've already applied to this vacancy." });

  const result = await db.transaction(async (trx) => {
    const referral = await trx.get(
      "SELECT * FROM staff_referrals WHERE seeker_email = ? AND vacancy_id = ? AND status = 'pending'",
      [user.email, vacancyId],
    );
    const history = referral
      ? [{ label: "Referred by PESO Staff", date: String(referral.created_at).slice(0, 10) }, { label: "Pending", date: today() }]
      : [{ label: "Pending", date: today() }];
    const created = await trx.run(`
      INSERT INTO applications (email, vacancy_id, status, date_applied, history, referral_status, referred_at, referred_by)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    `, [
      user.email,
      vacancyId,
      today(),
      JSON.stringify(history),
      referral ? "referred" : "not_referred",
      referral ? referral.created_at : "",
      referral ? referral.referred_by : "",
    ]);
    if (referral) {
      await trx.run("UPDATE staff_referrals SET status = 'accepted' WHERE id = ?", [referral.id]);
    }
    return { ...created, wasReferred: !!referral };
  });

  await notify(user.email, `Your application for ${vacancy.title} at ${vacancy.employer} has been submitted. The employer will review it directly.`);
  await logActivity({
    userEmail: user.email,
    userRole: "job_seeker",
    action: "job_application",
    relatedRecord: `vacancy #${vacancyId}`,
    performedBy: user.email,
    performedByRole: "job_seeker",
    remarks: result.wasReferred ? "Applied after PESO Staff referral" : "",
  });

  const row = (await db.get("SELECT * FROM applications WHERE id = ?", [result.lastInsertRowid]));
  send(res, 201, { application: serializeApplication(row) });
});

/* ---- Notifications ---- */
route("GET", "/api/notifications", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  const rows = (await db.all("SELECT * FROM notifications WHERE email = ? ORDER BY id DESC", [user.email]));
  send(res, 200, { notifications: rows.map(serializeNotification) });
});

route("POST", "/api/notifications/read-all", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  (await db.run("UPDATE notifications SET `read` = 1 WHERE email = ?", [user.email]));
  send(res, 200, { ok: true });
});

route("POST", "/api/notifications/:id/read", async (req, res, params) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  const result = await db.run("UPDATE notifications SET `read` = 1 WHERE id = ? AND email = ?", [Number(params.id), user.email]);
  if (result.changes === 0) return send(res, 404, { error: "Notification not found." });
  send(res, 200, { ok: true });
});

route("DELETE", "/api/notifications/:id", async (req, res, params) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  const result = (await db.run("DELETE FROM notifications WHERE id = ? AND email = ?", [Number(params.id), user.email]));
  if (result.changes === 0) return send(res, 404, { error: "Notification not found." });
  send(res, 200, { ok: true });
});

route("DELETE", "/api/notifications", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  (await db.run("DELETE FROM notifications WHERE email = ?", [user.email]));
  send(res, 200, { ok: true });
});

/* ---- Documents ---- */
route("GET", "/api/documents", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return send(res, 401, { error: "Not authenticated." });
  const rows = (await db.all("SELECT * FROM documents WHERE email = ? ORDER BY id DESC", [user.email]));
  send(res, 200, { documents: rows.map(serializeDocument) });
});

route("POST", "/api/documents", async (req, res) => {
  const user = await requireRole(req, res, ["job_seeker", "employer"]);
  if (!user) return;
  if (user.role === "job_seeker" && !["draft", "returned_for_completion"].includes(user.verification_status)) {
    return send(res, 423, { error: "Your profile is locked while pending or verified — documents can't be changed right now." });
  }
  const b = await readJsonBody(req);
  const { fileName, mimeType, dataBase64 } = b;
  if (!fileName || !dataBase64) return send(res, 400, { error: "fileName and dataBase64 are required." });

  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) return send(res, 413, { error: "File is larger than the 8MB limit." });

  const userDir = path.join(UPLOAD_DIR, crypto.createHash("sha256").update(user.email).digest("hex"));
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${Date.now()}-${safeName}`;
  fs.writeFileSync(path.join(userDir, storedName), buffer);

  const result = (await db.run(`
    INSERT INTO documents (email, original_name, stored_path, mime_type, size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [user.email, fileName, path.join(userDir, storedName), mimeType || "application/octet-stream", buffer.length, nowIso()]));

  const row = (await db.get("SELECT * FROM documents WHERE id = ?", [result.lastInsertRowid]));
  send(res, 201, { document: serializeDocument(row) });
});

route("DELETE", "/api/documents/:id", async (req, res, params) => {
  const user = await requireRole(req, res, ["job_seeker", "employer"]);
  if (!user) return;
  if (user.role === "job_seeker" && !["draft", "returned_for_completion"].includes(user.verification_status)) {
    return send(res, 423, { error: "Your profile is locked while pending or verified — documents can't be changed right now." });
  }
  const doc = (await db.get("SELECT * FROM documents WHERE id = ? AND email = ?", [Number(params.id), user.email]));
  if (!doc) return send(res, 404, { error: "Document not found." });
  fs.rm(doc.stored_path, { force: true }, () => {});
  (await db.run("DELETE FROM documents WHERE id = ?", [doc.id]));
  send(res, 200, { ok: true });
});

/* ================================================================
 * STAFF — Job Seeker & Employer verification queue, vacancy approval
 * ================================================================ */
route("GET", "/api/staff/seekers", async (req, res, params, url) => {
  if (!await requireStaffOrAdmin(req, res)) return;
  const status = url.searchParams.get("status");
  let rows;
  if (status && VERIFICATION_STATUSES.includes(status)) {
    rows = (await db.all("SELECT * FROM users WHERE role = 'job_seeker' AND verification_status = ? ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), CONCAT_WS(' ', first_name, surname))), email", [status]));
  } else {
    rows = (await db.all("SELECT * FROM users WHERE role = 'job_seeker' ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), CONCAT_WS(' ', first_name, surname))), email", []));
  }
  send(res, 200, {
    seekers: await Promise.all(rows.map(async (r) => {
      const docCount = (await db.get("SELECT COUNT(*) AS c FROM documents WHERE email = ?", [r.email])).c;
      return { ...serializeUser(r), documentCount: docCount };
    })),
  });
});

route("GET", "/api/staff/profile-edit-requests", async (req, res) => {
  if (!await requireRole(req, res, ["staff"])) return;
  const rows = await db.all(`
    SELECT * FROM users
    WHERE role IN ('job_seeker', 'employer') AND profile_edit_request_status = 'pending'
    ORDER BY profile_edit_requested_at, LOWER(email)
  `);
  send(res, 200, { requests: rows.map(serializeUser) });
});

route("POST", "/api/staff/profile-edit-requests/:email/:decision", async (req, res, params) => {
  const staffUser = await requireRole(req, res, ["staff"]);
  if (!staffUser) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const decision = params.decision;
  if (!["approve", "decline"].includes(decision)) return send(res, 400, { error: "Choose approve or decline." });

  const row = await db.get("SELECT * FROM users WHERE email = ? AND role IN ('job_seeker', 'employer')", [email]);
  if (!row) return send(res, 404, { error: "Profile edit request not found." });
  if (row.profile_edit_request_status !== "pending" || !["verified", "rejected"].includes(row.verification_status)) {
    return send(res, 409, { error: "This profile edit request is no longer pending." });
  }
  const body = await readJsonBody(req);
  const staffRemarks = typeof body.remarks === "string" ? body.remarks.trim() : "";
  const status = decision === "approve" ? "approved" : "declined";
  const nextVerificationStatus = decision === "approve" ? "returned_for_completion" : row.verification_status;
  const result = await db.run(`
    UPDATE users SET profile_edit_request_status = ?, verification_status = ?,
      verification_remarks = ?, verification_reviewed_at = ?, verification_reviewed_by = ?
    WHERE email = ? AND profile_edit_request_status = 'pending' AND verification_status IN ('verified', 'rejected')
  `, [
    status,
    nextVerificationStatus,
    decision === "approve" ? "PESO Staff approved your request. You may now edit and resubmit your profile for verification." : (staffRemarks || "PESO Staff declined your request to edit this profile."),
    nowIso(),
    staffUser.email,
    email,
  ]);
  if (!result.changes) return send(res, 409, { error: "This profile edit request has already been reviewed." });

  const remarks = staffRemarks || (decision === "approve" ? "Profile edit request approved." : "Profile edit request declined.");
  await logVerification({
    userEmail: email, userRole: row.role, previousStatus: row.verification_status,
    newStatus: nextVerificationStatus, action: `profile_edit_request_${status}`, remarks,
    performedBy: staffUser.email, performedByRole: staffUser.role,
  });
  await logActivity({
    userEmail: email, userRole: row.role, action: `profile_edit_request_${status}`,
    relatedRecord: email, performedBy: staffUser.email, performedByRole: staffUser.role, remarks,
  });
  await notify(email, decision === "approve"
    ? "PESO Staff approved your request. You can now edit your profile and submit it again for verification."
    : `PESO Staff declined your request to edit your profile.${staffRemarks ? ` Remarks: ${staffRemarks}` : ""}`);
  const updated = await db.get("SELECT * FROM users WHERE email = ?", [email]);
  send(res, 200, { profile: serializeUser(updated) });
});

route("GET", "/api/staff/seekers/:email", async (req, res, params) => {
  if (!await requireStaffOrAdmin(req, res)) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'job_seeker'", [email]));
  if (!row) return send(res, 404, { error: "Job Seeker not found." });
  const applications = (await db.all(`SELECT a.*, v.title AS vacancy_title, v.employer AS vacancy_employer FROM applications a
      JOIN vacancies v ON v.id = a.vacancy_id WHERE a.email = ? ORDER BY a.id DESC`, [email]))
    .map((r) => ({ ...serializeApplication(r), vacancyTitle: r.vacancy_title, vacancyEmployer: r.vacancy_employer }));
  send(res, 200, {
    profile: serializeUser(row),
    documents: (await db.all("SELECT * FROM documents WHERE email = ? ORDER BY id DESC", [email])).map(serializeDocument),
    applications,
    history: await getVerificationHistory(email),
  });
});

function verifyAccount(req, res, params, expectedRole) {
  return (async () => {
    const staffUser = await requireStaffOrAdmin(req, res);
    if (!staffUser) return;
    const email = decodeURIComponent(params.email).toLowerCase();
    const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = ?", [email, expectedRole]));
    if (!row) return send(res, 404, { error: "Account not found." });
    if (row.verification_status !== "pending_verification") {
      return send(res, 409, { error: "This profile is not currently pending verification." });
    }
    (await db.run("UPDATE users SET verification_status = 'verified', verification_remarks = '', verification_reviewed_at = ?, verification_reviewed_by = ? WHERE email = ?", [nowIso(), staffUser.email, email]));
    await logVerification({
      userEmail: email, userRole: expectedRole, previousStatus: "pending_verification", newStatus: "verified",
      action: "verified", remarks: "Requirements complete.", performedBy: staffUser.email, performedByRole: staffUser.role,
    });
    await logActivity({ userEmail: email, userRole: expectedRole, action: expectedRole === "job_seeker" ? "staff_verification" : "employer_verification", relatedRecord: email, performedBy: staffUser.email, performedByRole: staffUser.role });
    await notify(email, expectedRole === "job_seeker"
      ? "Your profile has been successfully verified by PESO Staff. You can now view job opportunities that match your qualifications and apply for available jobs."
      : "Your employer profile has been successfully verified by PESO Staff. You can now post job vacancies for PESO approval.");
    const updated = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
    const emailResult = await sendProfileReviewEmail({
      to: email,
      name: row.name || row.employer_business_name || row.employer_company_name,
      role: expectedRole,
      status: "verified",
    });
    if (!emailResult.sent) console.error(`Profile verification email could not be sent to ${email}.`);
    send(res, 200, { profile: serializeUser(updated) });
  })();
}
function returnAccount(req, res, params, expectedRole) {
  return (async () => {
    const staffUser = await requireStaffOrAdmin(req, res);
    if (!staffUser) return;
    const email = decodeURIComponent(params.email).toLowerCase();
    const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = ?", [email, expectedRole]));
    if (!row) return send(res, 404, { error: "Account not found." });
    if (row.verification_status !== "pending_verification") {
      return send(res, 409, { error: "This profile is not currently pending verification." });
    }
    const b = await readJsonBody(req);
    const remarks = (b.remarks || "").trim();
    if (!remarks) return send(res, 400, { error: "Please describe what is missing or incorrect before returning this profile." });
    (await db.run("UPDATE users SET verification_status = 'returned_for_completion', verification_remarks = ?, verification_reviewed_at = ?, verification_reviewed_by = ? WHERE email = ?", [remarks, nowIso(), staffUser.email, email]));
    await logVerification({
      userEmail: email, userRole: expectedRole, previousStatus: "pending_verification", newStatus: "returned_for_completion",
      action: "returned_for_completion", remarks, performedBy: staffUser.email, performedByRole: staffUser.role,
    });
    await logActivity({ userEmail: email, userRole: expectedRole, action: "staff_returned_profile", relatedRecord: email, performedBy: staffUser.email, performedByRole: staffUser.role, remarks });
    await notify(email, `Your profile has been reviewed by PESO Staff. Please update the following and submit again for verification. Staff Remarks: ${remarks}`);
    const updated = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
    const emailResult = await sendProfileReviewEmail({
      to: email,
      name: row.name || row.employer_business_name || row.employer_company_name,
      role: expectedRole,
      status: "returned_for_completion",
      remarks,
    });
    if (!emailResult.sent) console.error(`Profile completion email could not be sent to ${email}.`);
    send(res, 200, { profile: serializeUser(updated) });
  })();
}
function rejectAccount(req, res, params, expectedRole) {
  return (async () => {
    const staffUser = await requireStaffOrAdmin(req, res);
    if (!staffUser) return;
    const email = decodeURIComponent(params.email).toLowerCase();
    const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = ?", [email, expectedRole]));
    if (!row) return send(res, 404, { error: "Account not found." });
    if (row.verification_status !== "pending_verification") {
      return send(res, 409, { error: "This profile is not currently pending verification." });
    }
    const b = await readJsonBody(req);
    const remarks = (b.remarks || "").trim();
    (await db.run("UPDATE users SET verification_status = 'rejected', verification_remarks = ?, verification_reviewed_at = ?, verification_reviewed_by = ? WHERE email = ?", [remarks, nowIso(), staffUser.email, email]));
    await logVerification({
      userEmail: email, userRole: expectedRole, previousStatus: "pending_verification", newStatus: "rejected",
      action: "rejected", remarks, performedBy: staffUser.email, performedByRole: staffUser.role,
    });
    await logActivity({ userEmail: email, userRole: expectedRole, action: "staff_rejected_profile", relatedRecord: email, performedBy: staffUser.email, performedByRole: staffUser.role, remarks });
    await notify(email, `Your profile was not approved by PESO Staff.${remarks ? ` Remarks: ${remarks}` : ""}`);
    const updated = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
    const emailResult = await sendProfileReviewEmail({
      to: email,
      name: row.name || row.employer_business_name || row.employer_company_name,
      role: expectedRole,
      status: "rejected",
      remarks,
    });
    if (!emailResult.sent) console.error(`Profile rejection email could not be sent to ${email}.`);
    send(res, 200, { profile: serializeUser(updated) });
  })();
}

route("POST", "/api/staff/seekers/:email/verify", (req, res, params) => verifyAccount(req, res, params, "job_seeker"));
route("POST", "/api/staff/seekers/:email/return", (req, res, params) => returnAccount(req, res, params, "job_seeker"));
route("POST", "/api/staff/seekers/:email/reject", (req, res, params) => rejectAccount(req, res, params, "job_seeker"));

route("GET", "/api/staff/employers", async (req, res, params, url) => {
  if (!await requireStaffOrAdmin(req, res)) return;
  const status = url.searchParams.get("status");
  let rows;
  if (status && VERIFICATION_STATUSES.includes(status)) {
    rows = (await db.all("SELECT * FROM users WHERE role = 'employer' AND verification_status = ? ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), employer_business_name, employer_company_name)), email", [status]));
  } else {
    rows = (await db.all("SELECT * FROM users WHERE role = 'employer' ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), employer_business_name, employer_company_name)), email", []));
  }
  send(res, 200, { employers: rows.map(serializeUser) });
});

route("GET", "/api/staff/employers/:email", async (req, res, params) => {
  if (!await requireStaffOrAdmin(req, res)) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'employer'", [email]));
  if (!row) return send(res, 404, { error: "Employer not found." });
  send(res, 200, {
    profile: serializeUser(row),
    vacancies: (await db.all("SELECT * FROM vacancies WHERE employer_email = ? ORDER BY LOWER(title), id", [email])).map(serializeVacancy),
    documents: (await db.all("SELECT * FROM documents WHERE email = ? ORDER BY id DESC", [email])).map(serializeDocument),
    history: await getVerificationHistory(email),
  });
});

route("POST", "/api/staff/employers/:email/verify", (req, res, params) => verifyAccount(req, res, params, "employer"));
route("POST", "/api/staff/employers/:email/return", (req, res, params) => returnAccount(req, res, params, "employer"));
route("POST", "/api/staff/employers/:email/reject", (req, res, params) => rejectAccount(req, res, params, "employer"));

/** Section 3: Suspended is a status Staff can apply to a previously-Verified employer
 * (e.g. a compliance issue) — it immediately blocks new vacancy postings, same as an
 * unverified account, without discarding their verification history. Reactivate restores it. */
route("POST", "/api/staff/employers/:email/suspend", async (req, res, params) => {
  const staffUser = await requireStaffOrAdmin(req, res);
  if (!staffUser) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'employer'", [email]));
  if (!row) return send(res, 404, { error: "Employer not found." });
  const b = await readJsonBody(req);
  const remarks = (b.remarks || "").trim();
  (await db.run("UPDATE users SET verification_status = 'suspended', employer_suspension_reason = ?, verification_reviewed_at = ?, verification_reviewed_by = ? WHERE email = ?", [remarks, nowIso(), staffUser.email, email]));
  await logVerification({ userEmail: email, userRole: "employer", previousStatus: row.verification_status, newStatus: "suspended", action: "suspended", remarks, performedBy: staffUser.email, performedByRole: staffUser.role });
  await logActivity({ userEmail: email, userRole: "employer", action: "employer_suspended", relatedRecord: email, performedBy: staffUser.email, performedByRole: staffUser.role, remarks });
  await notify(email, `Your establishment account has been suspended by PESO Staff.${remarks ? ` Reason: ${remarks}` : ""}`);
  const updated = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  send(res, 200, { profile: serializeUser(updated) });
});
route("POST", "/api/staff/employers/:email/reactivate", async (req, res, params) => {
  const staffUser = await requireStaffOrAdmin(req, res);
  if (!staffUser) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'employer'", [email]));
  if (!row) return send(res, 404, { error: "Employer not found." });
  if (row.verification_status !== "suspended") return send(res, 409, { error: "This employer is not currently suspended." });
  (await db.run("UPDATE users SET verification_status = 'verified', employer_suspension_reason = '', verification_reviewed_at = ?, verification_reviewed_by = ? WHERE email = ?", [nowIso(), staffUser.email, email]));
  await logVerification({ userEmail: email, userRole: "employer", previousStatus: "suspended", newStatus: "verified", action: "reactivated", remarks: "", performedBy: staffUser.email, performedByRole: staffUser.role });
  await logActivity({ userEmail: email, userRole: "employer", action: "employer_reactivated", relatedRecord: email, performedBy: staffUser.email, performedByRole: staffUser.role });
  await notify(email, "Your establishment account has been reactivated by PESO Staff.");
  const updated = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  send(res, 200, { profile: serializeUser(updated) });
});

/* ---- Staff — Vacancy approval (Section 9) ---- */
route("GET", "/api/staff/vacancies", async (req, res, params, url) => {
  if (!await requireStaffOrAdmin(req, res)) return;
  await sweepExpiredVacancies();
  const status = url.searchParams.get("status");
  let rows;
  if (status && VACANCY_STATUSES.includes(status)) {
    rows = (await db.all("SELECT * FROM vacancies WHERE employer_email != '' AND status = ? ORDER BY LOWER(title), id", [status]));
  } else {
    rows = (await db.all("SELECT * FROM vacancies WHERE employer_email != '' ORDER BY LOWER(title), id", []));
  }
  send(res, 200, { vacancies: rows.map(serializeVacancy) });
});

route("POST", "/api/staff/vacancies/:id/approve", async (req, res, params) => {
  const staffUser = await requireStaffOrAdmin(req, res);
  if (!staffUser) return;
  const vac = (await db.get("SELECT * FROM vacancies WHERE id = ?", [Number(params.id)]));
  if (!vac) return send(res, 404, { error: "Vacancy not found." });
  if (vac.status !== "pending_approval") return send(res, 409, { error: "This vacancy is not pending approval." });
  if (isMissingVacancyValue(vac.title) || isMissingVacancyValue(vac.category)) {
    return send(res, 422, { error: "This vacancy is missing a valid title or category. Return it to the employer for correction before approval." });
  }
  const expiryDays = Number(vac.expiry_days) || 5;
  if (!isValidVacancyExpiryDays(expiryDays)) return send(res, 422, { error: "The vacancy expiry period must be between 2 and 5 days before approval." });
  const approvedAt = nowIso();
  (await db.run("UPDATE vacancies SET status = 'approved', remarks = '', approved_by = ?, approved_at = ?, posted = ?, valid_until = ? WHERE id = ?", [staffUser.email, approvedAt, approvedAt, vacancyExpiryDate(expiryDays), vac.id]));
  await logActivity({ userEmail: vac.employer_email, userRole: "employer", action: "job_vacancy_approval", relatedRecord: `vacancy #${vac.id}`, performedBy: staffUser.email, performedByRole: staffUser.role });
  if (vac.employer_email) await notify(vac.employer_email, `Your job vacancy "${vac.title}" has been approved by PESO Staff and is now visible to job seekers.`);
  if (vac.employer_email) await sendVacancyReviewEmail({ to: vac.employer_email, vacancyTitle: vac.title, status: "approved" });
  const row = (await db.get("SELECT * FROM vacancies WHERE id = ?", [vac.id]));
  send(res, 200, { vacancy: serializeVacancy(row) });
});

route("POST", "/api/staff/vacancies/:id/return", async (req, res, params) => {
  const staffUser = await requireStaffOrAdmin(req, res);
  if (!staffUser) return;
  const vac = (await db.get("SELECT * FROM vacancies WHERE id = ?", [Number(params.id)]));
  if (!vac) return send(res, 404, { error: "Vacancy not found." });
  if (vac.status !== "pending_approval") return send(res, 409, { error: "This vacancy is not pending approval." });
  const b = await readJsonBody(req);
  const remarks = (b.remarks || "").trim();
  if (!remarks) return send(res, 400, { error: "Please describe what needs to change before returning this vacancy." });
  (await db.run("UPDATE vacancies SET status = 'returned_for_completion', remarks = ? WHERE id = ?", [remarks, vac.id]));
  await logActivity({ userEmail: vac.employer_email, userRole: "employer", action: "job_vacancy_returned", relatedRecord: `vacancy #${vac.id}`, performedBy: staffUser.email, performedByRole: staffUser.role, remarks });
  if (vac.employer_email) await notify(vac.employer_email, `Your job vacancy "${vac.title}" needs changes before it can be approved. Staff Remarks: ${remarks}`);
  if (vac.employer_email) await sendVacancyReviewEmail({ to: vac.employer_email, vacancyTitle: vac.title, status: "returned_for_completion", remarks });
  const row = (await db.get("SELECT * FROM vacancies WHERE id = ?", [vac.id]));
  send(res, 200, { vacancy: serializeVacancy(row) });
});

/** A stronger "no" than Return for Completion — a Rejected vacancy is still editable
 * and resubmittable (Section 7 / Section 9: "Rejected → Employer receives rejection
 * reason and may edit/resubmit"), but records the outcome as a rejection rather than
 * a request for changes. */
route("POST", "/api/staff/vacancies/:id/reject", async (req, res, params) => {
  const staffUser = await requireStaffOrAdmin(req, res);
  if (!staffUser) return;
  const vac = (await db.get("SELECT * FROM vacancies WHERE id = ?", [Number(params.id)]));
  if (!vac) return send(res, 404, { error: "Vacancy not found." });
  if (vac.status !== "pending_approval") return send(res, 409, { error: "This vacancy is not pending approval." });
  const b = await readJsonBody(req);
  const remarks = (b.remarks || "").trim();
  if (!remarks) return send(res, 400, { error: "Please provide a rejection reason." });
  (await db.run("UPDATE vacancies SET status = 'rejected', remarks = ? WHERE id = ?", [remarks, vac.id]));
  await logActivity({ userEmail: vac.employer_email, userRole: "employer", action: "job_vacancy_rejected", relatedRecord: `vacancy #${vac.id}`, performedBy: staffUser.email, performedByRole: staffUser.role, remarks });
  if (vac.employer_email) await notify(vac.employer_email, `Your job vacancy "${vac.title}" was rejected by PESO Staff. Reason: ${remarks}. You may edit and resubmit it.`);
  if (vac.employer_email) await sendVacancyReviewEmail({ to: vac.employer_email, vacancyTitle: vac.title, status: "rejected", remarks });
  const row = (await db.get("SELECT * FROM vacancies WHERE id = ?", [vac.id]));
  send(res, 200, { vacancy: serializeVacancy(row) });
});

/* ---- Staff — Refer Seeker (Section 3): Staff may invite a qualified, verified
 * Job Seeker to review an approved vacancy. The invitation is not an application:
 * the Seeker must open the job details and choose to apply. A referral is only allowed
 * when the Seeker's computed Match Score meets the same threshold used on job listings. ---- */
route("GET", "/api/staff/refer/candidates/:vacancyId", async (req, res, params) => {
  if (!await requireStaffOrAdmin(req, res)) return;
  const vacancy = await db.get(`SELECT * FROM vacancies WHERE id = ? AND status = 'approved' AND ${PUBLIC_VACANCY_VALIDITY_SQL}`, [Number(params.vacancyId)]);
  if (!vacancy) return send(res, 404, { error: "Vacancy not found or not currently approved." });

  const seekers = (await db.all("SELECT * FROM users WHERE role = 'job_seeker' AND verification_status = 'verified'", []));
  const candidates = [];
  for (const seeker of seekers) {
    const already = (await db.get("SELECT id FROM applications WHERE email = ? AND vacancy_id = ?", [seeker.email, vacancy.id]));
    if (already) continue;
    const existingReferral = await db.get("SELECT id FROM staff_referrals WHERE seeker_email = ? AND vacancy_id = ? AND status = 'pending'", [seeker.email, vacancy.id]);
    if (existingReferral) continue;
    const docCount = (await db.get("SELECT COUNT(*) AS c FROM documents WHERE email = ?", [seeker.email])).c;
    if (!isProfileComplete(serializeUser(seeker), docCount)) continue;
    const breakdown = computeServerMatchScore(seeker, vacancy);
    if (breakdown.totalScore < MATCH_REFERRAL_THRESHOLD) continue;
    candidates.push({
      email: seeker.email,
      name: seeker.name,
      educationLevel: seeker.education_level,
      skills: seeker.skills,
      experience: seeker.experience,
      matchScore: breakdown.totalScore,
      matchBreakdown: breakdown,
    });
  }
  candidates.sort((a, b) => b.matchScore - a.matchScore);
  send(res, 200, { vacancy: serializeVacancy(vacancy), candidates });
});

route("POST", "/api/staff/refer", async (req, res) => {
  const staffUser = await requireStaffOrAdmin(req, res);
  if (!staffUser) return;
  const b = await readJsonBody(req);
  const seekerEmail = String(b.seekerEmail || "").trim().toLowerCase();
  const vacancyId = Number(b.vacancyId);
  if (!seekerEmail || !vacancyId) return send(res, 400, { error: "Please select both a Job Seeker and a job vacancy." });

  const seeker = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'job_seeker'", [seekerEmail]));
  if (!seeker) return send(res, 404, { error: "Job Seeker not found." });
  if (seeker.verification_status !== "verified") {
    return send(res, 409, { error: "This Job Seeker's profile has not been verified by PESO Staff yet." });
  }
  const docCount = (await db.get("SELECT COUNT(*) AS c FROM documents WHERE email = ?", [seeker.email])).c;
  if (!isProfileComplete(serializeUser(seeker), docCount)) {
    return send(res, 409, { error: "This Job Seeker's profile is incomplete." });
  }
  const vacancy = await db.get(`SELECT * FROM vacancies WHERE id = ? AND status = 'approved' AND ${PUBLIC_VACANCY_VALIDITY_SQL}`, [vacancyId]);
  if (!vacancy) return send(res, 404, { error: "Vacancy not found or not currently approved." });

  const dup = (await db.get("SELECT id FROM applications WHERE email = ? AND vacancy_id = ?", [seekerEmail, vacancyId]));
  if (dup) return send(res, 409, { error: "This Job Seeker already has an application for this vacancy." });
  const existingReferral = await db.get("SELECT id, status FROM staff_referrals WHERE seeker_email = ? AND vacancy_id = ?", [seekerEmail, vacancyId]);
  if (existingReferral?.status === "pending") return send(res, 409, { error: "This Job Seeker has already been referred to this vacancy." });
  if (existingReferral?.status === "accepted") return send(res, 409, { error: "This Job Seeker has already applied to this referred vacancy." });

  const breakdown = computeServerMatchScore(seeker, vacancy);
  if (breakdown.totalScore < MATCH_REFERRAL_THRESHOLD) {
    return send(res, 409, { error: `This Job Seeker's Match Score (${breakdown.totalScore}%) is below the ${MATCH_REFERRAL_THRESHOLD}% referral threshold for this vacancy.` });
  }

  const createdAt = nowIso();
  const result = existingReferral
    ? await db.run(
      "UPDATE staff_referrals SET referred_by = ?, status = 'pending', created_at = ? WHERE id = ?",
      [staffUser.email, createdAt, existingReferral.id],
    )
    : await db.run(`
      INSERT INTO staff_referrals (seeker_email, vacancy_id, referred_by, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `, [seekerEmail, vacancyId, staffUser.email, createdAt]);
  const referralId = existingReferral?.id || result.lastInsertRowid;

  await notify(seekerEmail, `PESO Staff recommends that you review the "${vacancy.title}" vacancy at ${vacancy.employer} (${breakdown.totalScore}% match). View the job details and choose whether to apply.`);
  await sendReferralInvitationEmail({
    to: seekerEmail,
    name: seeker.name,
    vacancyTitle: vacancy.title,
    employer: vacancy.employer,
    matchScore: breakdown.totalScore,
  });
  await logActivity({ userEmail: seekerEmail, userRole: "job_seeker", action: "staff_referral", relatedRecord: `vacancy #${vacancyId}`, performedBy: staffUser.email, performedByRole: staffUser.role, remarks: `Invitation #${referralId}; Match Score: ${breakdown.totalScore}%` });

  send(res, existingReferral ? 200 : 201, { referral: { id: referralId, seekerEmail, vacancyId, referredBy: staffUser.email, status: "pending", createdAt } });
});

route("GET", "/api/referrals", async (req, res) => {
  const user = await requireRole(req, res, ["job_seeker"]);
  if (!user) return;
  const rows = await db.all(`
    SELECT r.id AS referral_id, r.referred_by, r.status AS referral_status, r.created_at,
      v.*
    FROM staff_referrals r
    JOIN vacancies v ON v.id = r.vacancy_id
    WHERE r.seeker_email = ? AND r.status = 'pending'
      AND v.status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM applications a WHERE a.email = r.seeker_email AND a.vacancy_id = r.vacancy_id
      )
    ORDER BY r.id DESC
  `, [user.email]);
  send(res, 200, {
    referrals: rows.map((row) => ({
      id: row.referral_id,
      referredBy: row.referred_by,
      status: row.referral_status,
      createdAt: row.created_at,
      vacancy: serializeVacancy(row),
    })),
  });
});

route("DELETE", "/api/referrals/:id", async (req, res, params) => {
  const user = await requireRole(req, res, ["job_seeker"]);
  if (!user) return;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return send(res, 400, { error: "Invalid referral ID." });
  const result = await db.run(
    "DELETE FROM staff_referrals WHERE id = ? AND seeker_email = ? AND status = 'pending'",
    [id, user.email],
  );
  if (!result.changes) return send(res, 404, { error: "Pending referral not found." });
  await logActivity({ userEmail: user.email, userRole: "job_seeker", action: "staff_referral_cancelled", relatedRecord: `referral #${id}`, performedBy: user.email, performedByRole: "job_seeker" });
  send(res, 200, { ok: true });
});

/* ---- Staff/Admin — Application monitoring (Section 30: Staff MONITORS applications;
 * the Employer decides accept/reject. Staff referrals remain invitations until a
 * Job Seeker chooses to apply through POST /api/applications.) ---- */
route("GET", "/api/staff/applications", async (req, res) => {
  if (!await requireStaffOrAdmin(req, res)) return;
  const rows = (await db.all(`
    SELECT a.*, u.name AS seeker_name, u.contact_number AS seeker_contact_number,
      v.title AS vacancy_title, v.employer AS vacancy_employer
    FROM applications a
    JOIN users u ON u.email = a.email
    JOIN vacancies v ON v.id = a.vacancy_id
    ORDER BY a.id DESC
  `, []));
  send(res, 200, {
    applications: rows.map((r) => ({
      ...serializeApplication(r),
      seekerEmail: r.email,
      seekerName: r.seeker_name,
      seekerContact: r.seeker_contact_number || "",
      vacancyTitle: r.vacancy_title,
      vacancyEmployer: r.vacancy_employer,
    })),
  });
});

route("POST", "/api/staff/applications/:id/email", async (req, res, params) => {
  const staffUser = await requireStaffOrAdmin(req, res);
  if (!staffUser) return;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return send(res, 400, { error: "Invalid application ID." });
  const body = await readJsonBody(req);
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 4000) {
    return send(res, 400, { error: "Write a message of up to 4,000 characters before sending." });
  }

  const application = await db.get(`
    SELECT a.id, a.email, a.employer_status, a.status, u.name AS seeker_name, v.title AS vacancy_title
    FROM applications a
    JOIN users u ON u.email = a.email
    JOIN vacancies v ON v.id = a.vacancy_id
    WHERE a.id = ?
  `, [id]);
  if (!application) return send(res, 404, { error: "Application not found." });
  if (application.employer_status !== "accepted_hired" && application.status !== "hired") {
    return send(res, 409, { error: "Email follow-up is available only for hired applications." });
  }

  const result = await sendStaffFollowUpEmail({
    to: application.email,
    seekerName: application.seeker_name,
    message: body.message.trim(),
    vacancyTitle: application.vacancy_title,
  });
  if (!result.sent) {
    return send(res, 502, { error: "The email service could not send this message. Please try again later or contact the system administrator." });
  }

  await logActivity({
    userEmail: application.email,
    userRole: "job_seeker",
    action: "hired_seeker_email_sent",
    relatedRecord: `application #${application.id}: ${application.vacancy_title}`,
    performedBy: staffUser.email,
    performedByRole: staffUser.role,
    remarks: "Referral letter follow-up email sent.",
  });
  send(res, 200, { ok: true });
});

/* ================================================================
 * ADMIN — full oversight: profiles, verification history, activity log, staff accounts
 * ================================================================ */
route("GET", "/api/admin/seekers", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const rows = (await db.all("SELECT * FROM users WHERE role = 'job_seeker' ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), CONCAT_WS(' ', first_name, surname))), email", []));
  send(res, 200, {
    seekers: await Promise.all(rows.map(async (r) => {
      const profile = serializeUser(r);
      const documentCount = (await db.get("SELECT COUNT(*) AS c FROM documents WHERE email = ?", [r.email])).c;
      return {
        ...profile,
        profileComplete: isProfileComplete(profile, documentCount),
        applicationCount: (await db.get("SELECT COUNT(*) AS c FROM applications WHERE email = ?", [r.email])).c,
        documentCount,
      };
    })),
  });
});

route("GET", "/api/admin/seekers/:email", async (req, res, params) => {
  if (!await requireAdmin(req, res)) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'job_seeker'", [email]));
  if (!row) return send(res, 404, { error: "Seeker not found." });
  const applications = (await db.all(`SELECT a.*, v.title AS vacancy_title, v.employer AS vacancy_employer FROM applications a
      JOIN vacancies v ON v.id = a.vacancy_id WHERE a.email = ? ORDER BY a.id DESC`, [email]))
    .map((r) => ({ ...serializeApplication(r), vacancyTitle: r.vacancy_title, vacancyEmployer: r.vacancy_employer }));
  send(res, 200, {
    profile: serializeUser(row),
    applications,
    documents: (await db.all("SELECT * FROM documents WHERE email = ? ORDER BY id DESC", [email])).map(serializeDocument),
    history: await getVerificationHistory(email),
  });
});

route("DELETE", "/api/admin/seekers/:email", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const seeker = await db.get("SELECT email FROM users WHERE email = ? AND role = 'job_seeker'", [email]);
  if (!seeker) return send(res, 404, { error: "Job seeker not found." });

  try {
    await db.transaction(async (trx) => {
      await trx.run("DELETE FROM applications WHERE email = ?", [email]);
      await trx.run("DELETE FROM documents WHERE email = ?", [email]);
      await trx.run("DELETE FROM notifications WHERE email = ?", [email]);
      await trx.run("DELETE FROM sessions WHERE email = ?", [email]);
      await trx.run("DELETE FROM users WHERE email = ? AND role = 'job_seeker'", [email]);
    });
  } catch (error) {
    console.error("Could not delete job seeker:", error);
    return send(res, 500, { error: "Could not delete this job seeker." });
  }
  await removeUserUploadDirectory(email);
  await logActivity({ userEmail: email, userRole: "job_seeker", action: "job_seeker_account_deleted", relatedRecord: email, performedBy: admin.email, performedByRole: "admin" });
  send(res, 200, { ok: true });
});

route("GET", "/api/admin/employers", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const rows = (await db.all("SELECT * FROM users WHERE role = 'employer' ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), employer_business_name, employer_company_name)), email", []));
  send(res, 200, {
    employers: await Promise.all(rows.map(async (r) => ({
      ...serializeUser(r),
      vacancyCount: (await db.get("SELECT COUNT(*) AS c FROM vacancies WHERE employer_email = ?", [r.email])).c,
    }))),
  });
});

route("GET", "/api/admin/employers/:email", async (req, res, params) => {
  if (!await requireAdmin(req, res)) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const row = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'employer'", [email]));
  if (!row) return send(res, 404, { error: "Employer not found." });
  const vacancies = (await db.all("SELECT * FROM vacancies WHERE employer_email = ? ORDER BY LOWER(title), id", [email])).map(serializeVacancy);
  const vacancyIds = vacancies.map((v) => v.id);
  const applications = vacancyIds.length
    ? (await db.all(`SELECT a.*, u.name AS seeker_name, u.contact_number AS seeker_contact, u.skills AS seeker_skills,
          u.education_level AS seeker_education, u.course AS seeker_course, u.experience AS seeker_experience,
          v.title AS vacancy_title FROM applications a
        JOIN users u ON u.email = a.email JOIN vacancies v ON v.id = a.vacancy_id
        WHERE a.vacancy_id IN (${vacancyIds.map(() => "?").join(",")}) ORDER BY a.id DESC`, [...vacancyIds]))
        .map((r) => ({
          ...serializeApplication(r),
          seekerEmail: r.email,
          seekerName: r.seeker_name,
          seekerContact: r.seeker_contact,
          seekerSkills: r.seeker_skills,
          seekerEducation: r.seeker_education,
          seekerCourse: r.seeker_course,
          seekerExperience: r.seeker_experience,
          vacancyTitle: r.vacancy_title,
        }))
    : [];
  send(res, 200, { profile: serializeUser(row), vacancies, applications, documents: (await db.all("SELECT * FROM documents WHERE email = ? ORDER BY id DESC", [email])).map(serializeDocument), history: await getVerificationHistory(email) });
});

route("GET", "/api/admin/verification-history/:email", async (req, res, params) => {
  if (!await requireAdmin(req, res)) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  send(res, 200, { history: await getVerificationHistory(email) });
});

route("DELETE", "/api/admin/employers/:email", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const employer = await db.get("SELECT email FROM users WHERE email = ? AND role = 'employer'", [email]);
  if (!employer) return send(res, 404, { error: "Employer not found." });

  try {
    await db.transaction(async (trx) => {
      await trx.run("DELETE FROM applications WHERE vacancy_id IN (SELECT id FROM vacancies WHERE employer_email = ?)", [email]);
      await trx.run("DELETE FROM vacancies WHERE employer_email = ?", [email]);
      await trx.run("DELETE FROM documents WHERE email = ?", [email]);
      await trx.run("DELETE FROM notifications WHERE email = ?", [email]);
      await trx.run("DELETE FROM sessions WHERE email = ?", [email]);
      await trx.run("DELETE FROM users WHERE email = ? AND role = 'employer'", [email]);
    });
  } catch (error) {
    console.error("Could not delete employer:", error);
    return send(res, 500, { error: "Could not delete this employer and its vacancies." });
  }
  await removeUserUploadDirectory(email);
  await logActivity({ userEmail: email, userRole: "employer", action: "employer_account_deleted", relatedRecord: email, performedBy: admin.email, performedByRole: "admin" });
  send(res, 200, { ok: true });
});

route("GET", "/api/admin/activity-log", async (req, res, params, url) => {
  if (!await requireAdmin(req, res)) return;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
  const rows = (await db.all("SELECT * FROM activity_log ORDER BY id DESC LIMIT ?", [limit]));
  send(res, 200, { activity: rows.map(serializeActivity) });
});

route("DELETE", "/api/admin/activity-log", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const result = (await db.run("DELETE FROM activity_log", []));
  // Record that the log was cleared, and by whom, as the very first entry of the
  // now-empty log — so there's always a trace of who wiped it and when.
  await logActivity({ userEmail: admin.email, userRole: "admin", action: "activity_log_cleared", relatedRecord: `${result.changes} record(s)`, performedBy: admin.email, performedByRole: "admin" });
  send(res, 200, { ok: true, cleared: result.changes });
});

route("GET", "/api/admin/staff", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const rows = (await db.all("SELECT * FROM users WHERE role = 'staff' ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), email)), email", []));
  send(res, 200, { staff: rows.map(serializeUser) });
});

route("POST", "/api/admin/staff", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const b = await readJsonBody(req);
  const email = (b.email || "").trim().toLowerCase();
  const password = b.password || "";
  const name = (b.name || "").trim();
  if (!email || !name || !password) {
    return send(res, 400, { error: "Name, email, and password are required." });
  }
  if (!isStrongPassword(password)) {
    return send(res, 400, { error: PASSWORD_REQUIREMENTS_MESSAGE });
  }
  const existing = (await db.get("SELECT email FROM users WHERE email = ?", [email]));
  if (existing) return send(res, 409, { error: "An account with that email already exists." });
  const { hash, salt } = hashPassword(password);
  (await db.run(`
    INSERT INTO users (email, password_hash, password_salt, name, role, verification_status, email_verified, created_at)
    VALUES (?, ?, ?, ?, 'staff', 'verified', 1, ?)
  `, [email, hash, salt, name, nowIso()]));
  await logActivity({ userEmail: email, userRole: "staff", action: "staff_account_created", relatedRecord: email, performedBy: admin.email, performedByRole: "admin" });
  const row = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  send(res, 201, { staff: serializeUser(row) });
});

/** Admin edits a Staff account's name and/or resets their password. Email/role are
 * intentionally not editable here — a Staff account's identity shouldn't silently
 * change out from under them; delete-and-recreate is the path for that. */
route("PATCH", "/api/admin/staff/:email", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const staffRow = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'staff'", [email]));
  if (!staffRow) return send(res, 404, { error: "Staff account not found." });

  const b = await readJsonBody(req);
  const name = (b.name || "").trim();
  const password = b.password || "";
  if (!name) return send(res, 400, { error: "Name is required." });
  if (password && !isStrongPassword(password)) return send(res, 400, { error: PASSWORD_REQUIREMENTS_MESSAGE });

  if (password) {
    const { hash, salt } = hashPassword(password);
    (await db.run("UPDATE users SET name = ?, password_hash = ?, password_salt = ? WHERE email = ?", [name, hash, salt, email]));
    // Resetting the password invalidates existing sessions for this account, same as
    // the self-service password reset flow (Section 10).
    (await db.run("DELETE FROM sessions WHERE email = ?", [email]));
  } else {
    (await db.run("UPDATE users SET name = ? WHERE email = ?", [name, email]));
  }
  await logActivity({ userEmail: email, userRole: "staff", action: "staff_account_updated", relatedRecord: email, performedBy: admin.email, performedByRole: "admin", remarks: password ? "name and password updated" : "name updated" });
  const row = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  send(res, 200, { staff: serializeUser(row) });
});

/** Admin deletes a Staff account. Cleans up every related row so nothing is left
 * orphaned (Section 1's "no orphaned records" principle applied to this deletion too). */
route("DELETE", "/api/admin/staff/:email", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const staffRow = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'staff'", [email]));
  if (!staffRow) return send(res, 404, { error: "Staff account not found." });

  try {
    await db.transaction(async (trx) => {
      await trx.run("DELETE FROM sessions WHERE email = ?", [email]);
      await trx.run("DELETE FROM notifications WHERE email = ?", [email]);
      await trx.run("DELETE FROM users WHERE email = ?", [email]);
    });
  } catch (err) {
    return send(res, 500, { error: "Could not delete this staff account." });
  }
  await logActivity({ userEmail: email, userRole: "staff", action: "staff_account_deleted", relatedRecord: email, performedBy: admin.email, performedByRole: "admin" });
  send(res, 200, { ok: true });
});

/* ---- Admin Accounts (this request): same pattern as Staff Accounts above, so an
 * Admin can create additional Admin accounts and edit any Admin account's name or
 * password — including their own — from inside the dashboard rather than only via
 * the seeded default account or direct database access. ---- */
route("GET", "/api/admin/admins", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const rows = (await db.all("SELECT * FROM users WHERE role = 'admin' ORDER BY LOWER(COALESCE(NULLIF(TRIM(name), ''), email)), email", []));
  send(res, 200, { admins: rows.map(serializeUser) });
});

route("POST", "/api/admin/admins", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const b = await readJsonBody(req);
  const email = (b.email || "").trim().toLowerCase();
  const password = b.password || "";
  const name = (b.name || "").trim();
  if (!email || !name || !password) {
    return send(res, 400, { error: "Name, username/email, and password are required." });
  }
  if (!isStrongPassword(password)) {
    return send(res, 400, { error: PASSWORD_REQUIREMENTS_MESSAGE });
  }
  const existing = (await db.get("SELECT email FROM users WHERE email = ?", [email]));
  if (existing) return send(res, 409, { error: "An account with that username/email already exists." });
  const { hash, salt } = hashPassword(password);
  (await db.run(`
    INSERT INTO users (email, password_hash, password_salt, is_admin, name, role, verification_status, email_verified, created_at)
    VALUES (?, ?, ?, 1, ?, 'admin', 'verified', 1, ?)
  `, [email, hash, salt, name, nowIso()]));
  await logActivity({ userEmail: email, userRole: "admin", action: "admin_account_created", relatedRecord: email, performedBy: admin.email, performedByRole: "admin" });
  const row = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  send(res, 201, { admin: serializeUser(row) });
});

/** Admin edits an Admin account's name and/or resets their password — including
 * their own account. Email/username is intentionally not editable here, same as
 * Staff accounts above, to keep a stable identity for session/audit purposes. */
route("PATCH", "/api/admin/admins/:email", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  const targetRow = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'admin'", [email]));
  if (!targetRow) return send(res, 404, { error: "Admin account not found." });

  const b = await readJsonBody(req);
  const name = (b.name || "").trim();
  const password = b.password || "";
  if (!name) return send(res, 400, { error: "Name is required." });
  if (password && !isStrongPassword(password)) return send(res, 400, { error: PASSWORD_REQUIREMENTS_MESSAGE });

  const isSelf = email === admin.email;
  if (password) {
    const { hash, salt } = hashPassword(password);
    (await db.run("UPDATE users SET name = ?, password_hash = ?, password_salt = ? WHERE email = ?", [name, hash, salt, email]));
    // Resetting the password invalidates existing sessions for this account — including
    // the admin's own current session if they changed their own password, same as the
    // self-service password reset flow (Section 10). The frontend logs them out in that case.
    (await db.run("DELETE FROM sessions WHERE email = ?", [email]));
  } else {
    (await db.run("UPDATE users SET name = ? WHERE email = ?", [name, email]));
  }
  await logActivity({ userEmail: email, userRole: "admin", action: "admin_account_updated", relatedRecord: email, performedBy: admin.email, performedByRole: "admin", remarks: password ? "name and password updated" : "name updated" });
  const row = (await db.get("SELECT * FROM users WHERE email = ?", [email]));
  send(res, 200, { admin: serializeUser(row), selfPasswordChanged: isSelf && !!password });
});

/** Admin deletes an Admin account. Refuses to delete your own account (use the edit
 * form to change your own name/password instead) and refuses to delete the very
 * last remaining Admin account, so the system can never be locked out of Admin
 * access entirely. */
route("DELETE", "/api/admin/admins/:email", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const email = decodeURIComponent(params.email).toLowerCase();
  if (email === admin.email) {
    return send(res, 400, { error: "You can't delete your own account while logged into it." });
  }
  const targetRow = (await db.get("SELECT * FROM users WHERE email = ? AND role = 'admin'", [email]));
  if (!targetRow) return send(res, 404, { error: "Admin account not found." });

  const { c: adminCount } = (await db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"));
  if (adminCount <= 1) {
    return send(res, 400, { error: "Can't delete the last remaining Admin account." });
  }

  try {
    await db.transaction(async (trx) => {
      await trx.run("DELETE FROM sessions WHERE email = ?", [email]);
      await trx.run("DELETE FROM notifications WHERE email = ?", [email]);
      await trx.run("DELETE FROM users WHERE email = ?", [email]);
    });
  } catch (err) {
    return send(res, 500, { error: "Could not delete this admin account." });
  }
  await logActivity({ userEmail: email, userRole: "admin", action: "admin_account_deleted", relatedRecord: email, performedBy: admin.email, performedByRole: "admin" });
  send(res, 200, { ok: true });
});

route("GET", "/api/admin/vacancies", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  await sweepExpiredVacancies();
  const rows = (await db.all("SELECT * FROM vacancies ORDER BY LOWER(title), id", []));
  send(res, 200, { vacancies: rows.map(serializeVacancy) });
});

route("GET", "/api/admin/reports", async (req, res, params, url) => {
  if (!await requireAdmin(req, res)) return;
  const date = url.searchParams.get("date") || "";
  const month = url.searchParams.get("month") || "";
  if (!validateReportDate(date)) return send(res, 400, { error: "Choose a valid report date in YYYY-MM-DD format." });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return send(res, 400, { error: "Choose a valid report month in YYYY-MM format." });
  if (date.slice(0, 7) !== month) return send(res, 400, { error: "The report date must belong to the selected month." });

  const report = await getDailyReport(date);
  const [vacancyDates, seekerDates] = await Promise.all([
    db.all("SELECT LEFT(posted, 10) AS report_date, COUNT(*) AS record_count FROM vacancies WHERE LEFT(posted, 7) = ? GROUP BY LEFT(posted, 10)", [month]),
    db.all("SELECT LEFT(created_at, 10) AS report_date, COUNT(*) AS record_count FROM users WHERE role = 'job_seeker' AND LEFT(created_at, 7) = ? GROUP BY LEFT(created_at, 10)", [month]),
  ]);
  const datesWithData = [...vacancyDates, ...seekerDates].reduce((dates, row) => {
    if (row.report_date) dates[row.report_date] = (dates[row.report_date] || 0) + Number(row.record_count || 0);
    return dates;
  }, {});
  send(res, 200, { ...report, datesWithData });
});

route("GET", "/api/admin/reports/:reportFile", async (req, res, params, url) => {
  if (!await requireAdmin(req, res)) return;
  const reportFile = params.reportFile;
  if (!reportFile.endsWith(".pdf")) return send(res, 404, { error: "Report type not found." });
  const reportType = reportFile.slice(0, -4);
  if (!["vacancies", "seekers", "complete"].includes(reportType)) return send(res, 404, { error: "Report type not found." });
  const date = url.searchParams.get("date") || "";
  if (!validateReportDate(date)) return send(res, 400, { error: "Choose a valid report date in YYYY-MM-DD format." });

  const report = await getDailyReport(date);
  const pdf = await buildDailyReportPdf(report, reportType);
  const prefix = reportType === "vacancies" ? "Vacancy_Report" : reportType === "seekers" ? "Job_Seeker_Report" : "Complete_Daily_Report";
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${prefix}_${date}.pdf"`,
    "Content-Length": pdf.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  });
  res.end(pdf);
});

route("DELETE", "/api/admin/vacancies/:id", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return send(res, 400, { error: "Invalid vacancy ID." });
  const vacancy = await db.get("SELECT id, title, employer_email FROM vacancies WHERE id = ?", [id]);
  if (!vacancy) return send(res, 404, { error: "Vacancy not found." });

  try {
    await db.transaction(async (trx) => {
      await trx.run("DELETE FROM applications WHERE vacancy_id = ?", [id]);
      await trx.run("DELETE FROM vacancies WHERE id = ?", [id]);
    });
  } catch (error) {
    console.error("Could not delete vacancy:", error);
    return send(res, 500, { error: "Could not delete this vacancy and its applications." });
  }
  await logActivity({ userEmail: admin.email, userRole: "admin", action: "vacancy_deleted", relatedRecord: `vacancy #${id}: ${vacancy.title}`, performedBy: admin.email, performedByRole: "admin", remarks: vacancy.employer_email });
  send(res, 200, { ok: true });
});

/** Section 33: Admin monitors application outcomes system-wide — like Staff, Admin does
 * not decide anyone's application (Section 28: that's the Employer's call), so this is
 * read-only. There is intentionally no PATCH here. */
route("GET", "/api/admin/applications", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const rows = (await db.all(`
    SELECT a.*, u.name AS seeker_name, u.contact_number AS seeker_contact_number,
      v.title AS vacancy_title, v.employer AS vacancy_employer
    FROM applications a
    JOIN users u ON u.email = a.email
    JOIN vacancies v ON v.id = a.vacancy_id
    ORDER BY a.id DESC
  `, []));
  send(res, 200, {
    applications: rows.map((r) => ({
      ...serializeApplication(r),
      seekerEmail: r.email,
      seekerName: r.seeker_name,
      seekerContact: r.seeker_contact_number || "",
      vacancyTitle: r.vacancy_title,
      vacancyEmployer: r.vacancy_employer,
    })),
  });
});

route("DELETE", "/api/admin/applications/:id", async (req, res, params) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return send(res, 400, { error: "Invalid application ID." });
  const application = await db.get("SELECT id, email, vacancy_id FROM applications WHERE id = ?", [id]);
  if (!application) return send(res, 404, { error: "Application not found." });
  await db.run("DELETE FROM applications WHERE id = ?", [id]);
  await logActivity({ userEmail: application.email, userRole: "job_seeker", action: "application_deleted", relatedRecord: `application #${id} for vacancy #${application.vacancy_id}`, performedBy: admin.email, performedByRole: "admin" });
  send(res, 200, { ok: true });
});

/** Section 15–17: Staff/Admin (and the document's own owner — Section 37) can view the
 * ACTUAL uploaded file, not just its filename. Images and PDFs are served inline so they
 * render directly in a preview (see the frontend's docPreview modal); other types default
 * to a download. Pass ?download=1 to force a download regardless of type.
 * Auth: normally via the Authorization header, but a `?token=` query param is also accepted
 * so this URL can be used directly as an <img>/<iframe> src (which can't send custom headers). */
route("GET", "/api/documents/file/:id", async (req, res, params, url) => {
  const queryToken = url.searchParams.get("token");
  let user = await getUserFromRequest(req);
  if (!user && queryToken) {
    const session = (await db.get("SELECT * FROM sessions WHERE token = ?", [queryToken]));
    if (session && new Date(session.expires_at).getTime() >= Date.now()) {
      user = (await db.get("SELECT * FROM users WHERE email = ?", [session.email])) || null;
    }
  }
  if (!user) return send(res, 401, { error: "Not authenticated." });

  const doc = (await db.get("SELECT * FROM documents WHERE id = ?", [Number(params.id)]));
  if (!doc || !fs.existsSync(doc.stored_path)) return send(res, 404, { error: "Document not found." });

  // Only Staff/Admin, or the account that owns this document, may view it (Section 37).
  const isOwner = doc.email === user.email;
  const isStaffOrAdmin = user.role === "staff" || user.role === "admin";
  if (!isOwner && !isStaffOrAdmin) return send(res, 403, { error: "You do not have permission to view this document." });

  const forceDownload = url.searchParams.get("download") === "1";
  const previewableInline = /^image\//.test(doc.mime_type) || doc.mime_type === "application/pdf";
  const disposition = !forceDownload && previewableInline ? "inline" : "attachment";

  const stream = fs.createReadStream(doc.stored_path);
  res.writeHead(200, {
    "Content-Type": doc.mime_type,
    "Content-Disposition": `${disposition}; filename="${doc.original_name.replace(/"/g, "")}"`,
    "Access-Control-Allow-Origin": "*",
  });
  stream.pipe(res);
});

/* ================= HTTP SERVER / DISPATCH ================= */
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const matched = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
  if (!matched) return send(res, 404, { error: "Not found." });

  const match = url.pathname.match(matched.regex);
  const params = {};
  matched.paramNames.forEach((name, i) => (params[name] = match[i + 1]));

  try {
    await matched.handler(req, res, params, url);
  } catch (err) {
    console.error(err);
    send(res, err.statusCode || 500, { error: err.message || "Internal server error." });
  }
});

// Wait for the MySQL/MariaDB connection, schema setup, and seeding to finish
// before accepting any HTTP requests.
dbReady.then(async () => {
  await migratePendingStaffReferrals();
  await sweepExpiredVacancies();
  await sweepExpiredUnverifiedAccounts();
  setInterval(() => {
    sweepExpiredVacancies().catch((error) => {
      console.error("Automatic vacancy expiry sweep failed:", error);
    });
  }, 60_000);
  setInterval(() => {
    sweepExpiredUnverifiedAccounts().catch((error) => {
      console.error("Automatic unverified-account expiry sweep failed:", error);
    });
  }, 60_000);
  server.listen(PORT, () => {
    console.log(`PESO Gingoog backend listening on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error("PESO Gingoog backend could not start:", error);
  process.exitCode = 1;
});
