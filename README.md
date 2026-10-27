# PESO Gingoog City — Job Matching & Employment Management System

Four-role system: **Job Seeker**, **Employer**, **Staff**, and **Admin**, with a
full profile-verification workflow enforced on the backend (not just the UI).

```
PESO-merged/
├── backend/    Node.js REST API + MySQL/MariaDB (XAMPP) — run `npm install` once
└── frontend/   Vite + TypeScript + Tailwind site
```

**Database:** this project uses **MySQL/MariaDB via XAMPP**, not SQLite. Start
XAMPP's MySQL module before running the backend — see `backend/README.md` for
full setup. The `peso_db` database and all tables are created automatically on
first run.

## What's new in this update

- **Employer: View Seeker Profile.** On the Employer Dashboard's Applications tab,
  each applicant card now has a **View Profile** button that opens the seeker's
  full profile (name, contact, address, education, skills, trainings,
  eligibilities, licenses, work experience, job preferences, and a list of the
  documents on file) in a modal — sourced live from the same seeker account data
  Staff/Admin already see (`GET /api/employer/applications/:id/seeker`), so no
  profile data is duplicated anywhere. The most sensitive personal-verification
  fields (religion, TIN, 4Ps/household ID, disability details) stay Staff/Admin-only
  and aren't sent to Employers. Access is scoped server-side to applications for
  the requesting employer's own vacancies.
- **Find Jobs pagination fix.** The page previously called `$("jobsPagination")`
  against an element that didn't exist in `index.html`, so the whole pagination
  bar (including the Next button) silently failed to render. Added the missing
  `#jobsPagination` container and wired the search box/category filter to reset
  back to page 1 on every new search or filter (`jobsFilterChanged()`, which
  already existed but wasn't hooked up). Pagination is unchanged otherwise: 10
  vacancies per page, Back/page-number/Next controls, and it re-derives from
  whatever the current search/filter/match-sort has produced.
- **Admin daily reports.** Added a date-selectable calendar to the Admin
  Dashboard with real vacancy posting and job seeker registration data,
  accurate totals, empty states, and separate or combined PDF downloads. Report
  data and PDF requests are Admin-only on the backend. Dates use
  `vacancies.posted` and UTC `users.created_at`.
- **Alphabetical vacancy and account lists.** Vacancy listings and the Admin
  and Staff account queues now default to case-insensitive A–Z ordering.
  Verified job seekers can still choose the existing best-match ordering on
  Find Jobs; job-title order is the default.
- **Vacancy location picker.** Employers can search OpenStreetMap for a
  Gingoog City location, select a geocoded result, reposition a draggable
  marker, and confirm the exact pin before submitting. Existing saved
  coordinates continue to load in the picker.
- **Responsive refinements.** Dashboard navigation becomes horizontally
  scrollable on narrow screens, and report calendars and wide report tables
  remain usable on mobile without forcing page-wide horizontal scrolling.
- **Existing job listings removed.** The 15 sample vacancies that used to be
  seeded on first run are gone — `backend/seed-vacancies.json` is now empty, so
  a fresh `node server.js` starts with zero vacancies, ready for employers to
  post their own. Job-posting itself (draft → submit → Staff approval) is
  untouched. See `backend/scripts/reset-vacancies.js` above if you already have
  a `peso.db` with the old sample listings in it.


- **Role-based login/registration.** The login screen now asks "Login as: Job
  Seeker / Employer / Staff / Admin". Job Seekers and Employers can self-register;
  Staff accounts are created by an Admin (Admin Dashboard → Staff Accounts). The
  backend **always re-checks the selected role against the role stored in the
  database** and rejects the login if they don't match — the frontend's selection
  is never trusted on its own (see `requireRole` / the role check in
  `POST /api/auth/login` in `backend/server.js`).
- **Job Seeker verification workflow.** Saving a profile no longer unlocks job
  matching. A Job Seeker fills out the NSRP form, clicks **Save Progress** as
  often as they like, then **Submit for Verification** when it's complete. That
  locks the profile (`draft`/`returned_for_completion` → `pending_verification`)
  — editing, job matching, and applying are all blocked server-side until PESO
  Staff verifies it. Staff can **Verify**, **Return for Completion** (with
  required remarks), or **Reject** from the Staff Dashboard → Job Seeker
  Verification. A returned profile unlocks editing again; resubmitting re-locks
  it. Every action is recorded in an append-only `verification_history` table.
- **Employer verification + vacancy approval**, mirroring the same workflow:
  Employers submit a company profile for verification; once verified, they can
  post job vacancies, but each vacancy still needs Staff approval
  (`pending_approval` → `approved`) before it's visible to Job Seekers.
- **Staff Dashboard**: Job Seeker verification queue, Employer verification
  queue, vacancy approvals, and application/referral status review.
- **Admin Dashboard**: full read-only oversight of every Job Seeker and Employer
  profile (personal info, education, skills, work history, submitted
  documents), the complete verification history per account, Staff account
  management, and a system-wide, append-only Activity Log.
- Default seeded accounts (backend console prints these on first run too):
  - Admin: `admin` / `12345678`
  - Staff: `staff` / `12345678`
  - **Change both passwords before this goes anywhere near production.**

### Employer-Side Module (NSRP Form 2)

The Employer side has been rebuilt around PESO's actual NSRP Form 2
(Establishment Registration Form) and the PESO-mediated referral workflow,
without touching the Admin, Staff, or Job Seeker modules:

- **Establishment Profile** now captures the full NSRP Form 2 field set:
  Business/Trade Name, Acronym, TIN, Employer Type (Public/Private) with the
  matching sub-classification list, Nature of Work, Workforce Size, Line of
  Business, granular address (Street/Barangay/Municipality/Province), and a
  separate Establishment Contact Details section (Owner/President, Contact
  Person + Position, Telephone/Mobile/Fax/Email). Editing **Business Name,
  TIN, or Employer Type on an already-Verified establishment automatically
  drops it back to Pending Verification** — everything else can be edited
  freely without re-triggering review.
- **Employer statuses** now include **Suspended** in addition to Pending
  Verification / Verified / Rejected — Staff can suspend a Verified employer
  (e.g. for a compliance issue) and reactivate it later, from the employer's
  detail view in the Staff Dashboard.
- **Vacancies** follow the full NSRP lifecycle: **Draft** (save anytime,
  no PESO involvement) → **Submit for Approval** → Staff **Approve** /
  **Return for Changes** / **Reject** (with a required reason either way) →
  employer can **Edit & Resubmit** a returned/rejected vacancy → **Approved**
  (visible to Job Seekers) → **Expired** (automatic, once "Valid Until"
  passes) or **Close** (employer-initiated, e.g. position filled). The
  Qualification Requirements section (Work Experience, PWD acceptance +
  types, Returning OFW acceptance, Course/SHS Strand, License, Certification,
  Eligibility, Language/Dialect) is captured alongside the existing
  Education/Skills/Experience fields the match-score engine already uses.
- **Applications vs. Referrals, made explicit.** An Employer never sees a raw
  application. Staff reviews every application first and, only when they
  determine the applicant is qualified, uses **Refer to Employer** (Staff
  Dashboard → Application Review) to hand it off. Only referred applicants
  appear under the Employer's **Applications / Referrals** tab — with the
  seeker info they're permitted to see (contact, skills, education,
  experience) but no ability to edit the seeker's profile. The employer then
  manages their own pipeline (Under Employer Review → Shortlisted →
  Interview → Accepted/Hired or Not Selected) independently of PESO's own
  application-status pipeline.
- **Employer Dashboard** summary cards match the spec: Establishment
  Verification Status, Total/Pending/Approved/Rejected/Expired Vacancies,
  Total/Pending Referrals, and Hired/Closed — with quick actions for
  Complete Profile, Add Job Vacancy, Manage Vacancies, and View Referrals.
- All of this is enforced **server-side** — an employer cannot approve their
  own vacancy or verify their own account (only Staff/Admin routes can), and
  every employer route checks the vacancy/application actually belongs to
  the requesting employer's own `employer_email` before allowing access.

All existing features are preserved: the match-score algorithm, job browsing,
document uploads, notifications, and application/referral tracking all still
work exactly as before for Job Seekers — they're just now gated on Staff
verification per the new rules.

## Running it locally

You need **XAMPP running** (MySQL module started) plus two terminals.

**0. Start MySQL in XAMPP** — open the XAMPP Control Panel and click **Start**
next to MySQL. Leave it running.

**1. Backend** (requires Node.js 22.5+):
```bash
cd backend
npm install        # first time only — installs mysql2 and PDFKit
node server.js
```
This connects to XAMPP's MySQL, auto-creates the `peso_db` database and all
tables, seeds the default Admin and Staff accounts above (no sample job
listings — the system starts with zero vacancies so Employers post their own
from a clean slate), then listens on `http://localhost:3001`. An `uploads/`
folder is created automatically next to `server.js` for document uploads.

> Already have a `peso_db` with the previous sample vacancies in it? Run
> `node scripts/reset-vacancies.js --confirm` from `backend/` to remove them
> (it backs up the database first via `mysqldump` and never touches
> employer-posted vacancies, applications for those, or any account).
> `node scripts/reset-vacancies.js` with no flags does a dry run first so you
> can see what it would remove.

**2. Frontend**:
```bash
cd frontend
npm install
npm run dev
```
Open the URL Vite prints (usually `http://localhost:5173`). It talks to the
backend at `http://localhost:3001` by default — copy `frontend/.env.example` to
`frontend/.env` and set `VITE_API_BASE` if you run the backend somewhere else.

> Note: `node_modules` was removed before packaging this project, and the copy
> of it in the sandbox this was built in was missing the Linux native binding
> for its bundler (`@rolldown/binding-linux-x64-gnu`), so `npm run build` could
> not be verified end-to-end there. `npx tsc --noEmit` passes cleanly (no type
> errors) and `npm run dev` should work normally once you run `npm install` in
> your own environment; if `npm run build` still complains about a missing
> native binding, delete `node_modules` + `package-lock.json` and reinstall.

## Notes

- Job Seeker documents can only be added/removed while the profile is `draft`
  or `returned_for_completion` (i.e. not while locked).
- `frontend/src/data.ts` still exports a static `vacancies` array for
  reference/reseed purposes — it's not imported by `main.ts` (vacancies come
  from the backend now), and its type no longer matches `Vacancy` exactly since
  the approval-workflow fields (`status`, `employerEmail`, etc.) live only on
  the backend now.
- See `backend/README.md` for the full REST endpoint reference, including the
  new `/api/staff/*` and `/api/admin/*` routes.
