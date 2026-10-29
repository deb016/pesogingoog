# PESO Gingoog City — Backend

A real REST API + database for the Job Seeker Portal, backed by **MySQL/MariaDB
via XAMPP**. It uses `mysql2` for database access and PDFKit for generating
Admin reports; the API server uses Node's built-in `http` server and `fetch`.

This replaces the fake in-memory `DB` object in the frontend's `main.ts` with
an actual server: accounts persist across restarts, applications/notifications
are stored per account, uploaded documents are saved to disk, and there's now
an **admin API** that can see every seeker's profile, applications, and
documents — the piece that didn't exist before.

## Requirements

- Node.js **22.5 or newer** (check with `node -v`).
- **XAMPP**, with the **MySQL** module running — open the XAMPP Control Panel
  and click **Start** next to MySQL before starting this server. (On Linux,
  "XAMPP's MySQL" is MariaDB; on Windows/Mac it's the same thing XAMPP bundles.)

## Running it

```bash
cd backend
npm install          # installs mysql2 and PDFKit, first time only
node server.js
```

You should see:

```
Seeded default admin account: admin / 12345678  (change this password before going live)
Seeded default staff account: staff / 12345678  (change this password before going live)
Connected to MySQL/MariaDB (XAMPP) — database "peso_db" at 127.0.0.1:3306
PESO Gingoog backend listening on http://localhost:3001
```

A `peso_db` database and all its tables are created automatically in your
XAMPP MySQL instance on first run — no manual phpMyAdmin setup needed — and an
`uploads/` folder is created next to `server.js` for document uploads. The
system starts with **zero job vacancies** — `seed-vacancies.json` is
intentionally empty — so Employers post their own from a clean slate.
Everything you do — registering, posting/applying to jobs, uploading
documents — persists in that database, so it survives restarts (open
phpMyAdmin and drop the `peso_db` database, or run
`node scripts/reset-vacancies.js --confirm` / `node scripts/reset-database.js
--confirm` for targeted resets that don't require dropping everything).

If `node server.js` can't connect, it prints which host/port/user it tried —
double check XAMPP's MySQL module is actually started. By default this
connects as `root` with no password on `127.0.0.1:3306`, matching a stock
XAMPP install; override any of `DB_HOST` / `DB_PORT` / `DB_USER` /
`DB_PASSWORD` / `DB_NAME` via a `.env` file (see `.env.example`) if your setup
differs (e.g. you set a MySQL root password).

Admin report PDFs use PDFKit. Employer location search uses the public
OpenStreetMap Nominatim service through an authenticated backend route, with
query caching and a one-request-per-second upstream limit; no API key is needed.
New Job Seeker and Employer registrations that do not verify their email are
automatically deleted, along with associated uploaded files, seven days after
registration. Resending the verification email does not extend this period;
existing accounts are not included. The remaining time is shown on the email
verification screen and beside eligible incomplete drafts in the Staff lists.
PESO Staff verification, return-for-completion, and rejection decisions also
send email notifications to the affected Job Seeker or Employer. Return and
rejection emails include the Staff remarks when provided. These messages use
the configured Brevo email service (`BREVO_API_KEY` and `BREVO_SENDER_EMAIL`);
in-app notifications are still created if email delivery is unavailable. Staff
job referrals email the referred Job Seeker, and vacancy approval, return, and
rejection decisions email the Employer; return and rejection messages include
the Staff remarks.

**Change the seeded admin password** before this goes anywhere near production
— it's only there so you have something to log into immediately.

## Wiring up the existing frontend

The frontend (`PESO-updated`) currently keeps everything in an in-memory `DB`
object inside `main.ts`. To connect it to this backend, the shape of the swap
is:

1. Replace direct `DB.currentUser = ...` / `DB.applications` reads and writes
   with `fetch()` calls to the endpoints below.
2. Store the `token` you get back from `/api/auth/login` or
   `/api/auth/register` (e.g. in a module-level variable) and send it as
   `Authorization: Bearer <token>` on every subsequent request.
3. Point `fetch` at `http://localhost:3001` in development (the server sends
   permissive CORS headers so this works straight from the Vite dev server).

The JSON shapes returned by `/api/vacancies`, `/api/applications`,
`/api/notifications`, and `/api/profile` match `types.ts` field-for-field
(`camelCase`, same keys), so the rendering code in `main.ts` (`jobCard`,
`appRow`, etc.) shouldn't need to change — only *where the data comes from*
changes.

## API Reference

All request/response bodies are JSON. Authenticated routes require an
`Authorization: Bearer <token>` header.

### Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | `{ name, email, password }` | Returns `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` | Returns `{ token, user }` |
| POST | `/api/auth/logout` | — | Invalidates the token |
| GET | `/api/auth/me` | — | Returns `{ user }` for the current token |

New passwords must be at least 6 characters and contain at least one letter and
one number. This is enforced by the API for registration, password resets, and
Staff/Admin account creation or password changes.

### Vacancies (public, no auth needed)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/vacancies` | All vacancies |
| GET | `/api/vacancies/:id` | One vacancy |

Employer vacancy forms include an interactive OpenStreetMap location picker.
The Employer dashboard separates saved Draft vacancies from Posted vacancies,
including those pending approval, approved, returned, rejected, expired, or closed.
Employers choose an expiry period of 2–5 days. The period starts when PESO approves
the vacancy; expired approved vacancies are removed from public listings automatically.
A map pin is required before submitting a vacancy for PESO approval; its
latitude and longitude are saved with the listing and shown on the job detail
page. OpenStreetMap attribution is displayed on the map.

### Profile

| Method | Path | Body |
|---|---|---|
| GET | `/api/profile` | — |
| PUT | `/api/profile` | Full `JobSeeker`-shaped object (see `types.ts`) |
| POST | `/api/profile/edit-request` | `{ remarks }` | Verified/rejected Job Seekers or Employers request Staff permission to edit |

### Applications

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/applications` | — | Current user's applications |
| POST | `/api/applications` | `{ vacancyId }` | 422 if profile incomplete, 409 if already applied |
| GET | `/api/referrals` | Pending PESO job invitations for the signed-in Job Seeker; invitations are not applications |
| DELETE | `/api/referrals/:id` | Cancel a pending PESO invitation; it is removed from the seeker's invitation list |

### Notifications

| Method | Path |
|---|---|
| GET | `/api/notifications` |
| POST | `/api/notifications/read-all` |

### Documents

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/documents` | — | Metadata only (name, size, date) |
| POST | `/api/documents` | `{ fileName, mimeType, dataBase64 }` | 8MB limit per file |
| DELETE | `/api/documents/:id` | — | |

`dataBase64` is the file's raw bytes, base64-encoded — e.g. in the browser:
```js
const toBase64 = (file) => new Promise((res) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(",")[1]);
  r.readAsDataURL(file);
});
```

### Admin (requires an account with `isAdmin: true` — only the seeded
`admin` account has this by default)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/seekers` | Every seeker's profile + counts |
| GET | `/api/admin/seekers/:email` | One seeker's full profile + applications + documents |
| DELETE | `/api/admin/seekers/:email` | Delete a seeker account and its applications/documents |
| GET | `/api/admin/employers` | Every employer account + vacancy counts |
| DELETE | `/api/admin/employers/:email` | Delete an employer, its vacancies, and applications on those vacancies |
| GET | `/api/admin/vacancies` | Vacancy inventory, including status and expiry |
| DELETE | `/api/admin/vacancies/:id` | Delete a vacancy and its applications |
| GET | `/api/admin/applications` | Every application across every seeker, with seeker/vacancy names attached |
| DELETE | `/api/admin/applications/:id` | Delete an application |
| PATCH | `/api/admin/applications/:id` | `{ status }` — one of `pending, checking, approved, waiting, hired, declined`. Also auto-notifies the seeker |
| GET | `/api/admin/documents/:id` | Streams/downloads the actual uploaded file |
| GET | `/api/admin/reports?date=YYYY-MM-DD&month=YYYY-MM` | Daily vacancy and newly registered job seeker rows plus calendar day indicators |
| GET | `/api/admin/reports/vacancies.pdf?date=YYYY-MM-DD` | Download all vacancies posted on the selected date |
| GET | `/api/admin/reports/seekers.pdf?date=YYYY-MM-DD` | Download all job seekers registered on the selected date |
| GET | `/api/admin/reports/complete.pdf?date=YYYY-MM-DD` | Download both report sections |

### Employer

| Method | Path | Notes |
|---|---|---|
| GET | `/api/employer/location-search?q=...` | Search OpenStreetMap for Gingoog City locations; cached and rate-limited |
| POST | `/api/employer/vacancies` | Create a draft or submit a vacancy; `expiryDays` must be 2, 3, 4, or 5 |
| PUT | `/api/employer/vacancies/:id` | Update a draft or returned vacancy, including `expiryDays` |
| POST | `/api/employer/vacancies/:id/submit` | Submit a draft or returned vacancy for PESO approval |
| GET | `/api/employer/applications` | Applications for the employer's own vacancies, with the seeker summary fields (name, contact, skills, education, experience) already used on the Applications tab |
| GET | `/api/employer/applications/:id/seeker` | The applicant's full profile (education, skills, trainings, eligibilities, licenses, work experience, job preferences, documents-on-file list) — powers the "View Profile" button. 404s unless `:id` is an application for one of the requesting employer's own vacancies |
| PATCH | `/api/employer/applications/:id` | `{ employerStatus, remarks? }` — moves the employer's own pipeline status and auto-notifies the seeker |

### Profile edit requests

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/staff/profile-edit-requests` | — | Pending requests for Job Seekers and Employers |
| POST | `/api/staff/profile-edit-requests/:email/:decision` | `{ remarks? }` | Staff can `approve` or `decline`; approval returns the profile for completion so the user can edit and resubmit |

### Staff job referrals

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/staff/refer` | `{ seekerEmail, vacancyId }` | Creates an in-app notification and emails the seeker a job invitation; the seeker reviews vacancy details and must apply before the employer sees an application |
| POST | `/api/staff/applications/:id/email` | `{ message }` | Staff/Admin can email a message of up to 4,000 characters to the seeker on a hired application; delivery uses the configured Brevo email service |

The protected Admin dashboard in the frontend uses these endpoints for
read-only application monitoring and the vacancy inventory.

Reports use the database's existing UTC date convention. Vacancy reports filter
`vacancies.posted`, while job seeker reports filter `users.created_at` (account
registration time); neither uses application or last-update dates. The
backend validates the selected date and month and uses parameterized SQL.
PDFs include the complete matching datasets, not just visible preview rows.

## Where this is a mock-database-shaped starting point, not a finished product

This is enough to actually run, store real data, and demo the full seeker →
admin loop. Before putting it in front of the public, you'd still want to:

- **Move file storage off local disk** to something like S3 / Cloudflare R2 /
  DigitalOcean Spaces if you deploy to a host with an ephemeral filesystem
  (most cheap hosts wipe local files on redeploy).
- **Add input validation** more thoroughly (email format, phone number
  format, file type checks on uploads).
- **Rate-limit** `/api/auth/login` and `/api/auth/register` against brute
  force / spam signups.
- **Serve over HTTPS** and set `Secure`/short-lived tokens if you move from
  bearer tokens in memory to something like cookies.
- **Back up the `peso_db` database regularly** — e.g. `mysqldump -u root
  peso_db > backup.sql` (both `scripts/reset-vacancies.js` and
  `scripts/reset-database.js` already do this automatically before they touch
  anything).
- **Add password reset** — there's no "forgot password" flow yet.

None of that changes the architecture — it's all additive to what's here.
