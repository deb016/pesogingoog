import "./style.css";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import type { ActivityLogEntry, Application, ApplicationStatus, AppNotification, AuthUser, DocumentMeta, EducationLevel, StaffReferral, UserRole, Vacancy, VerificationHistoryEntry } from "./types";
import { OTHER_SKILLS_LIST, DISABILITY_TYPES, SELF_EMPLOYED_SUBTYPES, JOBSEEKER_CATEGORIES, LANGUAGES, LANGUAGE_SKILLS, REFERRED_TO_OPTIONS } from "./data";
import type { WorkExperienceEntry, TrainingEntry, EligibilityEntry, LicenseEntry } from "./types";
import { computeMatchScore, matchTier } from "./matching";
import * as api from "./api";
import { ApiError } from "./api";

/* ================= APPLICATION STATE (now backed by the real PESO backend) ================= */
let vacancies: Vacancy[] = [];
let currentUser: AuthUser | null = null;
let applications: Application[] = [];
let pendingStaffReferrals: StaffReferral[] = [];
let notifications: AppNotification[] = [];
let activeHiredNoticeId: number | null = null;
const shownHiredNoticeIds = new Set<number>();
let documents: DocumentMeta[] = [];
let currentAvatarData = "";
let myVerificationHistory: VerificationHistoryEntry[] = [];

/** The logged-in user's applications (empty array if not logged in / none yet). */
function currentApplications(): Application[] {
  return applications.filter((application) => !application.isStaffReferral);
}

/** The logged-in user's notifications (empty array if not logged in / none yet). */
function currentNotifications(): AppNotification[] {
  return notifications;
}

/** Shared "Notifications" tab body used by both the Job Seeker and Employer
 * dashboards: marks everything read, offers a "Clear All" action, and lets the
 * user delete individual notifications one at a time. */
function notificationsTabHtml(description: string): string {
  const list = currentNotifications();
  return `
    <div class="flex items-start justify-between gap-3 mb-1">
      <h1 class="font-display text-2xl font-semibold">Notifications</h1>
      ${list.length ? `<button onclick="clearAllNotificationsAction()" class="text-xs font-semibold px-3 py-1.5 rounded-lg border flex-shrink-0" style="border-color:var(--color-border); color:var(--color-muted)">Clear All</button>` : ""}
    </div>
    <p class="text-sm mb-6" style="color:var(--color-muted)">${description}</p>
    <div class="space-y-3 stagger-grid" id="notificationsListBody">
      ${
        list.length
          ? list.map(notificationRowHtml).join("")
          : `<p class="text-sm" style="color:var(--color-muted)">You have no notifications yet.</p>`
      }
    </div>
  `;
}

function notificationRowHtml(n: AppNotification): string {
  return `
    <div class="card rounded-xl p-4 flex gap-3 items-start">
      <div class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style="background:var(--color-accent)"></div>
      <div class="flex-1 min-w-0"><p class="text-sm">${n.message}</p><p class="text-xs mt-1" style="color:var(--color-muted)">${n.date}</p></div>
      <button onclick="deleteNotificationAction(${n.id})" title="Delete notification" class="flex-shrink-0 text-xs px-2 py-1 rounded-lg hover:bg-black/5" style="color:var(--color-muted)">&times;</button>
    </div>`;
}

async function deleteNotificationAction(id: number) {
  const previous = notifications;
  notifications = notifications.filter((n) => n.id !== id);
  const body = document.getElementById("notificationsListBody");
  if (body) {
    body.innerHTML = notifications.length
      ? notifications.map(notificationRowHtml).join("")
      : `<p class="text-sm" style="color:var(--color-muted)">You have no notifications yet.</p>`;
  }
  try {
    await api.deleteNotification(id);
  } catch (err) {
    notifications = previous;
    showToast(errMsg(err, "Could not delete this notification."));
    dashTabInner("notifications");
  }
}

async function clearAllNotificationsAction() {
  const previous = notifications;
  notifications = [];
  dashTabInner("notifications");
  try {
    await api.clearAllNotifications();
    showToast("All notifications cleared.");
  } catch (err) {
    notifications = previous;
    showToast(errMsg(err, "Could not clear notifications."));
    dashTabInner("notifications");
  }
}

/** The logged-in user's uploaded document metadata (empty array if not logged in / none yet). */
function currentDocuments(): DocumentMeta[] {
  return documents;
}

async function refreshPendingStaffReferrals(): Promise<void> {
  if (currentUser?.role !== "job_seeker") {
    pendingStaffReferrals = [];
    return;
  }
  pendingStaffReferrals = await api.getStaffReferrals();
  const referralVacancies = pendingStaffReferrals.map((referral) => referral.vacancy);
  vacancies = [...vacancies.filter((vacancy) => !referralVacancies.some((referred) => referred.id === vacancy.id)), ...referralVacancies];
}

/** Loads applications, notifications, and documents for whoever is currently logged in. */
async function loadUserData(): Promise<void> {
  if (!currentUser) {
    applications = [];
    pendingStaffReferrals = [];
    notifications = [];
    documents = [];
    currentAvatarData = "";
    myVerificationHistory = [];
    return;
  }
  try {
    const [apps, notifs, docs, avatarData] = await Promise.all([api.getApplications(), api.getNotifications(), api.getDocuments(), api.getAvatar()]);
    applications = apps;
    notifications = notifs;
    documents = docs;
    currentAvatarData = avatarData;
  } catch {
    // Leave whatever we had; the next successful load (e.g. a tab switch) will refresh it.
  }
  if (currentUser.role === "job_seeker") {
    try {
      await refreshPendingStaffReferrals();
    } catch (err) {
      showToast(errMsg(err, "Could not load PESO job referrals."));
    }
  } else {
    pendingStaffReferrals = [];
  }
  showPendingHiredNotice();
  try {
    if (currentUser.role === "job_seeker") {
      myVerificationHistory = await api.getProfileHistory();
    } else if (currentUser.role === "employer") {
      myVerificationHistory = (await api.getEmployerProfile()).history;
    }
  } catch {
    // Non-critical — the status card just won't show a timeline until the next refresh.
  }
}

function showPendingHiredNotice(): void {
  if (currentUser?.role !== "job_seeker" || activeHiredNoticeId !== null) return;
  const notice = notifications.find((item) =>
    !item.read
    && !shownHiredNoticeIds.has(item.id)
    && item.message.startsWith("Congratulations! You have been marked as hired for "),
  );
  if (!notice) return;

  activeHiredNoticeId = notice.id;
  shownHiredNoticeIds.add(notice.id);
  const title = document.getElementById("hiredNoticeTitle");
  const message = document.getElementById("hiredNoticeMessage");
  const vacancyTitle = notice.message
    .replace(/^Congratulations! You have been marked as hired for /, "")
    .replace(/\. Please proceed to the PESO office to claim your referral letter\.$/, "");
  if (title) title.textContent = `Congratulations, you’re hired${vacancyTitle ? ` for ${vacancyTitle}` : ""}!`;
  if (message) message.textContent = "Your employer has confirmed your hiring.";
  $("hiredNoticeOverlay").classList.remove("hidden");
  $("hiredNoticeOverlay").querySelector<HTMLButtonElement>("button")?.focus();
}

async function closeHiredNotice(): Promise<void> {
  const notificationId = activeHiredNoticeId;
  activeHiredNoticeId = null;
  $("hiredNoticeOverlay").classList.add("hidden");
  if (notificationId !== null) {
    const notice = notifications.find((item) => item.id === notificationId);
    if (notice) notice.read = true;
    renderNavAuth();
    try {
      await api.markNotificationRead(notificationId);
    } catch (err) {
      if (notice) notice.read = false;
      renderNavAuth();
      showToast(errMsg(err, "Could not mark the hiring notice as read."));
    }
  }
  showPendingHiredNotice();
}

async function refreshSeekerNotifications(): Promise<void> {
  if (currentUser?.role !== "job_seeker") return;
  try {
    notifications = await api.getNotifications();
    renderNavAuth();
    showPendingHiredNotice();
  } catch (err) {
    console.error("Could not refresh job seeker notifications:", err);
  }
}

const STATUS_META: Record<ApplicationStatus, { label: string; pill: string }> = {
  pending: { label: "Pending", pill: "status-pending" },
  checking: { label: "Employer is reviewing your application", pill: "status-checking" },
  approved: { label: "Your Application is approved", pill: "status-approved" },
  waiting: { label: "Waiting for employer's decision", pill: "status-waiting" },
  hired: { label: "Hired! Congratulations", pill: "status-hired" },
  declined: { label: "Not selected this time", pill: "status-declined" },
};

let currentDashTab = "overview";
let profileDirty = false;
let pendingNavAction: (() => void) | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/* ================= UNSAVED PROFILE CHANGES GUARD ================= */
/**
 * If the seeker has unsaved edits sitting in the "My Profile" form, intercept the
 * requested navigation and ask them to save/discard first instead of silently
 * wiping their input (e.g. an accidental click on "My Applications").
 */
function guardUnsavedProfile(proceed: () => void) {
  if (currentDashTab === "profile" && profileDirty && currentUser) {
    pendingNavAction = proceed;
    $("unsavedModalOverlay").classList.remove("hidden");
    return;
  }
  proceed();
}

async function resolveUnsavedModal(choice: "save" | "discard" | "cancel") {
  $("unsavedModalOverlay").classList.add("hidden");
  if (choice === "cancel") {
    pendingNavAction = null;
    return;
  }
  if (choice === "save") {
    const saved = await persistProfileForm();
    if (!saved) {
      pendingNavAction = null;
      return;
    }
  } else {
    profileDirty = false;
  }
  const action = pendingNavAction;
  pendingNavAction = null;
  if (action) action();
}

window.addEventListener("beforeunload", (e) => {
  if (profileDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ================= NAVIGATION ================= */
function nav(view: string) {
  guardUnsavedProfile(() => navInner(view));
}

function navInner(view: string) {
  if (view !== "dashboard" && currentUser?.role === "staff") clearStaffReviewDetail();
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`view-${view}`).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "jobs") {
    currentJobsPage = 1;
    renderJobsList();
    refreshVacancies().catch((err) => {
      showToast(errMsg(err, "Could not refresh the job listings."));
    });
  }
  if (view === "login") renderLoginRoleSelector();
  if (view === "register") renderRegisterRoleSelector();
  if (view === "dashboard") dashTabInner(currentDashTab);
  renderNavAuth();
  updateActiveNavLink(view);
  closeMobileMenu();
}

/** Marks whichever of Home / Find Jobs / About matches the current view as
 * "active" (color + a visible indicator) in both the desktop nav and the
 * mobile menu — other views (login, dashboard, etc.) clear all of them. */
function updateActiveNavLink(view: string) {
  document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((btn) => {
    const isActive = btn.dataset.nav === view;
    btn.classList.toggle("active", isActive);
    if (isActive) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

/** Labels the shared listings page according to the current user's job role. */
function updateJobsNavLabel() {
  const isEmployer = currentUser?.role === "employer";
  const isAdmin = currentUser?.role === "admin";
  const label = isEmployer ? "Jobs" : isAdmin ? "View Jobs" : "Find Jobs";
  const navLabel = document.getElementById("navJobsLabel");
  if (navLabel) navLabel.textContent = label;
  const navLabelMobile = document.getElementById("navJobsLabelMobile");
  if (navLabelMobile) navLabelMobile.textContent = label;
  const pageHeading = document.getElementById("jobsPageHeading");
  if (pageHeading) pageHeading.textContent = label;
}

/* ================= MOBILE NAV MENU ================= */
function toggleMobileMenu() {
  const panel = document.getElementById("mobileNavPanel");
  const toggle = document.getElementById("mobileMenuToggle");
  if (!panel || !toggle) return;
  const nowOpen = !panel.classList.contains("open");
  panel.classList.toggle("open", nowOpen);
  toggle.classList.toggle("open", nowOpen);
  toggle.setAttribute("aria-expanded", String(nowOpen));
  toggle.setAttribute("aria-label", nowOpen ? "Close menu" : "Open menu");
}
function closeMobileMenu() {
  const panel = document.getElementById("mobileNavPanel");
  const toggle = document.getElementById("mobileMenuToggle");
  if (!panel || !toggle) return;
  panel.classList.remove("open");
  toggle.classList.remove("open");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open menu");
}
// Close the mobile menu on outside click or Escape, same conventions as the
// modal overlays elsewhere in this app.
document.addEventListener("click", (e) => {
  const panel = document.getElementById("mobileNavPanel");
  const toggle = document.getElementById("mobileMenuToggle");
  if (!panel || !toggle || !panel.classList.contains("open")) return;
  const target = e.target as Node;
  if (!panel.contains(target) && !toggle.contains(target)) closeMobileMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMobileMenu();
});

function renderNavAuth() {
  updateJobsNavLabel();
  const area = $("navAuthArea");
  if (currentUser) {
    const unread = currentNotifications().filter((n) => !n.read).length;
    area.innerHTML = `
      <button onclick="nav('dashboard'); dashTab('notifications')" class="relative p-2 rounded-lg hover:bg-black/5" title="Notifications">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
        ${unread > 0 ? `<span class="absolute top-1 right-1 w-2 h-2 rounded-full notif-pulse" style="background:var(--color-warn)"></span>` : ""}
      </button>
      <button onclick="nav('dashboard')" class="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full hover:bg-black/5">
        <div class="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center text-xs font-bold text-white" style="background:var(--color-primary)">${currentAvatarData ? `<img src="${currentAvatarData}" alt="Profile photo" class="w-full h-full object-cover">` : currentUser.name?.charAt(0) ?? "?"}</div>
        <span class="text-sm font-medium hidden sm:inline">${currentUser.name?.split(" ")[0] ?? ""}</span>
      </button>
      <button onclick="doLogout()" class="text-sm font-medium px-3 py-2 hover:opacity-70">Log Out</button>
    `;
  } else {
    area.innerHTML = `
      <button onclick="nav('login')" class="text-sm font-medium px-3 py-2 hover:opacity-70">Log In</button>
      <button onclick="nav('register')" class="btn-primary text-sm font-semibold px-4 py-2 rounded-lg">Register</button>
    `;
  }
}

/* ================= AUTH ================= */
let selectedLoginRole: UserRole = "job_seeker";
let selectedRegisterRole: "job_seeker" | "employer" = "job_seeker";
let pendingRegistrationExpiresAt = "";
const LOGIN_ROLE_OPTIONS: { key: UserRole; label: string }[] = [
  { key: "job_seeker", label: "Job Seeker" },
  { key: "employer", label: "Employer" },
  { key: "staff", label: "Staff" },
  { key: "admin", label: "Admin" },
];

function renderLoginRoleSelector() {
  $("loginRoleSelector").innerHTML = LOGIN_ROLE_OPTIONS.map(
    (o) => `
    <button type="button" onclick="selectLoginRole('${o.key}')" class="px-3 py-2 rounded-lg border text-center" style="${
      o.key === selectedLoginRole ? "background:var(--color-primary); color:#fff; border-color:var(--color-primary)" : "border-color:var(--color-border)"
    }">${o.label}</button>`,
  ).join("");
  syncLoginEmailFieldForRole();
}
function selectLoginRole(role: string) {
  if (role !== selectedLoginRole) {
    const emailInput = document.getElementById("loginEmail") as HTMLInputElement | null;
    const passwordInput = document.getElementById("loginPassword") as HTMLInputElement | null;
    if (emailInput) emailInput.value = "";
    if (passwordInput) {
      passwordInput.value = "";
      hidePasswordVisibility("loginPassword");
    }
  }
  selectedLoginRole = role as UserRole;
  renderLoginRoleSelector();
}
// Staff/Admin accounts are provisioned internally with a short username (e.g.
// "admin"), not necessarily a real email address, so the field adapts per role.
// Called whenever the role selector is (re-)rendered, so it's always in sync
// whether this is a fresh page load, a role switch, or returning to this view.
function syncLoginEmailFieldForRole() {
  const isInternal = selectedLoginRole === "staff" || selectedLoginRole === "admin";
  const label = document.getElementById("loginEmailLabel");
  if (label) label.textContent = isInternal ? "Username" : "Email";
  const input = document.getElementById("loginEmail") as HTMLInputElement | null;
  if (input) input.placeholder = isInternal ? "username" : "you@example.com";
}

function registrationExpiryTimerHtml(expiresAt: string | undefined): string {
  const timestamp = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(timestamp)) return "";
  return `<p class="text-xs mt-2 font-semibold" style="color:#8A5A0F" role="timer" aria-live="polite" data-registration-expiry="${new Date(timestamp).toISOString()}"></p>`;
}

function updateRegistrationExpiryTimers(): void {
  document.querySelectorAll<HTMLElement>("[data-registration-expiry]").forEach((timer) => {
    const expiresAt = Date.parse(timer.dataset.registrationExpiry || "");
    if (!Number.isFinite(expiresAt)) return;
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    if (remaining === 0) {
      timer.textContent = "Draft expired — it is scheduled for automatic deletion.";
      return;
    }
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    timer.textContent = `Time left before automatic deletion: ${days}d ${hours}h ${minutes}m ${seconds}s`;
  });
}

function renderRegisterRoleSelector() {
  $("regRoleSelector").innerHTML = ["job_seeker", "employer"]
    .map(
      (r) => `
    <button type="button" onclick="selectRegisterRole('${r}')" class="px-3 py-2 rounded-lg border text-center" style="${
      r === selectedRegisterRole ? "background:var(--color-primary); color:#fff; border-color:var(--color-primary)" : "border-color:var(--color-border)"
    }">${r === "job_seeker" ? "Job Seeker" : "Employer"}</button>`,
    )
    .join("");
  $("regNameLabel").textContent = selectedRegisterRole === "employer" ? "Company / Contact Name" : "Full Name";
}
function selectRegisterRole(role: string) {
  if (role !== selectedRegisterRole) {
    document.querySelector<HTMLFormElement>("#view-register form")?.reset();
    hidePasswordVisibility("regPassword");
    hidePasswordVisibility("regConfirmPassword");
  }
  selectedRegisterRole = role as typeof selectedRegisterRole;
  renderRegisterRoleSelector();
}

/** Registering only creates the account (name + email + password) on the backend.
 * These sensible defaults are applied locally so the profile form doesn't start
 * totally blank; they're only actually saved once the seeker hits "Save Profile". */
function applyDefaultProfileFields(u: AuthUser): AuthUser {
  if (u.role !== "job_seeker") return u;
  return Object.assign(
    {
      municipality: "Gingoog City",
      province: "Misamis Oriental",
      employmentStatus: "Unemployed",
      isOFW: "No",
      is4Ps: "No",
      workType: "Full-time",
      workLocation: "Local",
      applicationType: "New Applicant",
      currentlyInSchool: "No",
      disabilityTypes: [] as string[],
      jobSeekerCategory: [] as string[],
      preferredLocalAreas: [] as string[],
      preferredOverseasCountries: [] as string[],
      languageProficiency: {} as Record<string, string[]>,
      trainings: [] as TrainingEntry[],
      eligibilities: [] as EligibilityEntry[],
      licenses: [] as LicenseEntry[],
      workExperiences: [] as WorkExperienceEntry[],
      referredTo: [] as string[],
    },
    u,
  );
}

/** Section 5: Gmail-only requirement, checked on the frontend too (never rely only on
 *  the backend — but the backend re-validates regardless, see server.js). */
const GMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i;

async function doLogin(e: Event): Promise<boolean> {
  e.preventDefault();
  const email = $<HTMLInputElement>("loginEmail").value.trim().toLowerCase();
  const password = $<HTMLInputElement>("loginPassword").value;
  try {
    currentUser = await api.login(email, password, selectedLoginRole);
    await loadUserData();
    showToast(`Welcome back, ${currentUser.name?.split(" ")[0] ?? "there"}!`);
    // Always land on the dashboard Overview after logging in — never jump straight
    // into a stale tab (e.g. Profile) left over from a previous session in this tab.
    currentDashTab = "overview";
    nav("dashboard");
  } catch (err) {
    if (err instanceof ApiError && err.data?.requiresVerification) {
      showToast("Please verify your Gmail address before logging in.");
      $<HTMLInputElement>("resendEmail").value = err.data.email || email;
      $("verifyEmailMessage").textContent = "Your account hasn't been verified yet. Please check your Gmail inbox, or resend the verification email below.";
      pendingRegistrationExpiresAt = err.data.registrationExpiresAt || "";
      $("registrationExpiryNotice").innerHTML = registrationExpiryTimerHtml(pendingRegistrationExpiresAt);
      updateRegistrationExpiryTimers();
      navInner("verify-email");
    } else {
      showToast(errMsg(err, "Login failed."));
    }
  }
  return false;
}

async function doRegister(e: Event): Promise<boolean> {
  e.preventDefault();
  const name = $<HTMLInputElement>("regName").value || (selectedRegisterRole === "employer" ? "New Employer" : "New Job Seeker");
  const email = $<HTMLInputElement>("regEmail").value.trim().toLowerCase();
  const password = $<HTMLInputElement>("regPassword").value;
  const confirmPassword = $<HTMLInputElement>("regConfirmPassword").value;

  if (!GMAIL_REGEX.test(email)) {
    showToast("Please use a valid Gmail address (@gmail.com).");
    return false;
  }
  if (password !== confirmPassword) {
    showToast("Password and confirmation do not match.");
    return false;
  }

  try {
    const result = await api.register(name, email, password, confirmPassword, selectedRegisterRole);
    showToast(result.message || "Account created! Please check your Gmail to verify your account.");
    $<HTMLInputElement>("resendEmail").value = result.email || email;
    $("verifyEmailMessage").textContent = `We've sent a verification link to ${result.email || email}. Please open it to activate your account before logging in.`;
    pendingRegistrationExpiresAt = result.registrationExpiresAt;
    $("registrationExpiryNotice").innerHTML = registrationExpiryTimerHtml(pendingRegistrationExpiresAt);
    updateRegistrationExpiryTimers();
    navInner("verify-email");
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      showToast("This Gmail address is already registered. Please log in or use Forgot Password.");
      nav("login");
    } else {
      showToast(errMsg(err, "Registration failed."));
    }
  }
  return false;
}

async function doResendVerification(): Promise<void> {
  const email = $<HTMLInputElement>("resendEmail").value.trim().toLowerCase();
  if (!GMAIL_REGEX.test(email)) {
    showToast("Please enter the Gmail address you registered with.");
    return;
  }
  try {
    const result = await api.resendVerification(email);
    showToast(result.message || "If that account needs verification, a new email has been sent.");
  } catch (err) {
    showToast(errMsg(err, "Could not resend verification email."));
  }
}

function openVerificationEmail(): void {
  const email = $<HTMLInputElement>("resendEmail").value.trim().toLowerCase();
  if (!GMAIL_REGEX.test(email)) {
    showToast("Please enter the Gmail address you registered with.");
    return;
  }
  const query = encodeURIComponent(`to:${email} subject:"Verify your PESO Gingoog City account"`);
  const authUser = encodeURIComponent(email);
  window.open(`https://mail.google.com/mail/?authuser=${authUser}#search/${query}`, "_blank", "noopener,noreferrer");
}

async function doForgotPassword(e: Event): Promise<boolean> {
  e.preventDefault();
  const email = $<HTMLInputElement>("forgotEmail").value.trim().toLowerCase();
  try {
    const result = await api.forgotPassword(email);
    showToast(result.message || "If an account is associated with this Gmail address, a password reset email has been sent.");
    nav("login");
  } catch (err) {
    showToast(errMsg(err, "Could not process that request."));
  }
  return false;
}

let pendingResetToken: string | null = null;
async function doResetPassword(e: Event): Promise<boolean> {
  e.preventDefault();
  const password = $<HTMLInputElement>("resetPassword").value;
  const confirmPassword = $<HTMLInputElement>("resetConfirmPassword").value;
  if (!pendingResetToken) {
    showToast("This reset link is missing its token. Please use the link from your email again.");
    return false;
  }
  if (password !== confirmPassword) {
    showToast("Password and confirmation do not match.");
    return false;
  }
  try {
    const result = await api.resetPassword(pendingResetToken, password, confirmPassword);
    showToast(result.message || "Password successfully updated. Please log in.");
    pendingResetToken = null;
    nav("login");
  } catch (err) {
    showToast(errMsg(err, "Could not reset password. The link may have expired."));
  }
  return false;
}

/** Handles the links sent in the verification/reset emails: /?verify=TOKEN or /?reset=TOKEN. */
async function handleAuthLinkParams(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get("verify");
  const resetToken = params.get("reset");
  if (verifyToken) {
    window.history.replaceState({}, "", window.location.pathname);
    try {
      currentUser = applyDefaultProfileFields(await api.verifyEmail(verifyToken));
      await loadUserData();
      showToast("Email verified! You're now logged in.");
      currentDashTab = "overview";
      navInner("dashboard");
      return true;
    } catch (err) {
      showToast(errMsg(err, "This verification link is invalid or has expired."));
      navInner("verify-email");
      return true;
    }
  }
  if (resetToken) {
    window.history.replaceState({}, "", window.location.pathname);
    pendingResetToken = resetToken;
    navInner("reset-password");
    return true;
  }
  return false;
}

function doLogout() {
  $("logoutConfirmOverlay").classList.remove("hidden");
  $("logoutConfirmOverlay").querySelector<HTMLButtonElement>("button")?.focus();
}

function closeLogoutConfirmModal() {
  $("logoutConfirmOverlay").classList.add("hidden");
}

function confirmLogout() {
  closeLogoutConfirmModal();
  guardUnsavedProfile(() => {
    api.logout().catch(() => {});
    currentUser = null;
    applications = [];
    notifications = [];
    documents = [];
    showToast("You've been logged out.");
    navInner("home");
  });
}

/* ================= PASSWORD SHOW/HIDE TOGGLE ================= *
 * Shared "eye" icon used on every password field (login, register, reset, and the
 * Admin/Staff account forms) so a person can check what they actually typed before
 * submitting. `passwordFieldHtml` renders the label + input + toggle button
 * together for dynamically-generated forms; the few static password fields in
 * index.html use the same markup/classes by hand and call the same toggle
 * function, so behavior and appearance stay identical everywhere. */
function passwordFieldHtml(
  id: string,
  labelText: string,
  opts: { required?: boolean; minlength?: number; placeholder?: string; autocomplete?: string } = {},
): string {
  return `
    <label for="${id}" class="text-xs font-semibold block mb-1.5">${labelText}</label>
    ${passwordInputHtml(id, opts)}`;
}
/** Just the input+toggle wrapper, for the few spots where the label markup
 * doesn't follow the standard pattern above. */
function passwordInputHtml(
  id: string,
  opts: { required?: boolean; minlength?: number; placeholder?: string; autocomplete?: string } = {},
): string {
  return `
    <div class="relative">
      <input id="${id}" type="password" ${opts.required ? "required" : ""} ${opts.minlength ? `minlength="${opts.minlength}"` : ""} ${
        opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : ""
      } ${opts.placeholder ? `placeholder="${opts.placeholder}"` : ""} class="w-full border rounded-lg pl-3 pr-10 py-2.5 text-sm" style="border-color:var(--color-border)" />
      <button type="button" onpointerdown="showPasswordVisibility('${id}')" onpointerup="hidePasswordVisibility('${id}')" onpointerleave="hidePasswordVisibility('${id}')" onpointercancel="hidePasswordVisibility('${id}')" onblur="hidePasswordVisibility('${id}')" onkeydown="if(event.key === ' ' || event.key === 'Enter') showPasswordVisibility('${id}')" onkeyup="if(event.key === ' ' || event.key === 'Enter') hidePasswordVisibility('${id}')" aria-label="Hold to show password" id="${id}-toggle" class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-black/5">
        ${eyeIconSvg(id, true)}
        ${eyeIconSvg(id, false)}
      </button>
    </div>`;
}
function eyeIconSvg(id: string, open: boolean): string {
  const path = open
    ? `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`
    : `<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.9 21.9 0 0 1 5.06-6.06M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`;
  return `<svg id="${id}-eye-${open ? "open" : "closed"}" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-muted); ${open ? "" : "display:none"}">${path}</svg>`;
}
function showPasswordVisibility(id: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  const openEye = document.getElementById(`${id}-eye-open`);
  const closedEye = document.getElementById(`${id}-eye-closed`);
  const toggleBtn = document.getElementById(`${id}-toggle`);
  if (!input || !openEye || !closedEye) return;
  input.type = "text";
  openEye.style.display = "none";
  closedEye.style.display = "";
  if (toggleBtn) toggleBtn.setAttribute("aria-label", "Release to hide password");
}
function hidePasswordVisibility(id: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  const openEye = document.getElementById(`${id}-eye-open`);
  const closedEye = document.getElementById(`${id}-eye-closed`);
  const toggleBtn = document.getElementById(`${id}-toggle`);
  if (!input || !openEye || !closedEye) return;
  input.type = "password";
  openEye.style.display = "";
  closedEye.style.display = "none";
  if (toggleBtn) toggleBtn.setAttribute("aria-label", "Hold to show password");
}

/* ================= TOAST ================= */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("toast-visible");
  // Force reflow so re-triggering the animation on back-to-back toasts still slides in cleanly.
  void t.offsetWidth;
  t.classList.add("toast-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("toast-visible"), 3200);
}

/* ================= MATCH SCORE UI HELPERS ================= */
/** Job cards only badge a match % once it's a genuinely good fit — weak matches show
 * nothing rather than discouraging a seeker with a low number. */
const MATCH_DISPLAY_THRESHOLD = 70;

/** Job matching / applying to jobs is only unlocked once Staff has verified the
 *  seeker's profile (Rule 3 / Rule 4 / Rule 9) — being merely "complete" isn't enough. */
function isVerifiedSeeker(u: AuthUser | null): boolean {
  return !!u && u.role === "job_seeker" && u.verificationStatus === "verified";
}

function matchPillHtml(job: Vacancy): string {
  if (!isVerifiedSeeker(currentUser) || !isProfileComplete(currentUser)) return "";
  const { totalScore } = computeMatchScore(currentUser, job);
  if (totalScore < MATCH_DISPLAY_THRESHOLD) return "";
  const tier = matchTier(totalScore);
  return `<span class="match-pill match-${tier}">${totalScore}% Match</span>`;
}

function matchBreakdownHtml(job: Vacancy): string {
  if (!currentUser) {
    return `<div class="rounded-lg p-4 text-xs" style="background:var(--color-bg); color:var(--color-muted)">Log in and complete your profile to see your personalized match score for this job.</div>`;
  }
  if (currentUser.role !== "job_seeker") return "";
  if (currentUser.verificationStatus === "pending_verification") {
    return `<div class="rounded-lg p-4 text-xs" style="background:#FCEFD9; color:#8A5A0F">Your profile must be verified by PESO Staff before job matching and job applications become available.</div>`;
  }
  if (currentUser.verificationStatus === "returned_for_completion") {
    return `<div class="rounded-lg p-4 text-xs" style="background:#FBE3E1; color:#9B2C22">PESO Staff returned your profile for missing information. <button onclick="nav('dashboard'); dashTab('profile')" class="underline font-semibold">Update &amp; resubmit &rarr;</button></div>`;
  }
  if (!isProfileComplete(currentUser)) {
    return `<div class="rounded-lg p-4 text-xs" style="background:#FCEFD9; color:#8A5A0F">Complete your Jobseeker Profile to unlock your personalized Match Score for this job. <button onclick="nav('dashboard'); dashTab('profile')" class="underline font-semibold">Complete Profile &rarr;</button></div>`;
  }
  if (currentUser.verificationStatus !== "verified") {
    return `<div class="rounded-lg p-4 text-xs" style="background:#FCEFD9; color:#8A5A0F">Submit your profile for verification to unlock job matching. <button onclick="nav('dashboard'); dashTab('profile')" class="underline font-semibold">Go to My Profile &rarr;</button></div>`;
  }
  const b = computeMatchScore(currentUser, job);
  const tier = matchTier(b.totalScore);
  const isStrongMatch = b.totalScore >= MATCH_DISPLAY_THRESHOLD;
  const row = (label: string, value: number) => `
    <div class="flex items-center gap-3">
      <span class="text-xs w-24 flex-shrink-0" style="color:var(--color-muted)">${label}</span>
      <div class="match-bar-track flex-1"><div class="match-bar-fill" style="width:${value}%; background:var(--color-primary)"></div></div>
      <span class="text-xs font-semibold w-9 text-right">${value}%</span>
    </div>`;
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-sm">Your Match Score</h3>
        ${isStrongMatch ? `<span class="match-pill match-${tier} text-sm">${b.totalScore}%</span>` : `<span class="text-xs font-semibold" style="color:var(--color-muted)">Below match threshold</span>`}
      </div>
      <div class="space-y-2.5 mb-3">
        ${row("Education (40%)", b.educationScore)}
        ${row("Skills (35%)", b.skillsScore)}
        ${row("Experience (25%)", b.experienceScore)}
      </div>
      ${!isStrongMatch ? `<p class="text-[11px] mb-3" style="color:#8A5A0F">This job isn't a strong fit yet (matches are only badged at ${MATCH_DISPLAY_THRESHOLD}%+). See the breakdown above for where to improve.</p>` : ""}
      <p class="text-[11px]" style="color:var(--color-muted)">Based on your Jobseeker Profile. Update your profile to improve your match results.</p>
    </div>`;
}

/* ================= JOB CARD RENDERING ================= */
/** Prefixes a salary value with the Peso sign for display, without double-prefixing
 * if an employer already typed one in themselves. */
function formatSalary(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return s;
  return s.startsWith("\u20b1") ? s : `\u20b1${s}`;
}

function jobCard(job: Vacancy): string {
  return `
  <button onclick="openJob(${job.id})" class="card rounded-xl p-5 text-left hover:shadow-md transition-shadow group">
    <div class="flex items-start justify-between mb-2 gap-2">
      <span class="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded" style="background:#DCEAF7; color:#1D5A85">${job.category}</span>
      ${matchPillHtml(job) || `<span class="text-[10px]" style="color:var(--color-muted)">${timeAgo(job.posted)}</span>`}
    </div>
    <h3 class="font-display font-semibold text-base mb-1 group-hover:opacity-70">${job.title}</h3>
    <p class="text-sm mb-3" style="color:var(--color-muted)">${job.employer}</p>
    <div class="flex items-center justify-between text-xs" style="color:var(--color-muted)">
      <span>${job.location}</span>
      <span class="font-semibold" style="color:var(--color-primary)">${formatSalary(job.salary)}</span>
    </div>
  </button>`;
}

function timeAgo(dateStr: string): string {
  const days = Math.max(0, Math.round((new Date("2026-07-26").getTime() - new Date(dateStr).getTime()) / 86400000));
  return days === 0 ? "Today" : days === 1 ? "1 day ago" : days + " days ago";
}

function renderFeaturedJobs() {
  $("featuredJobsGrid").innerHTML = vacancies.slice(0, 3).map(jobCard).join("");
}

function renderHomeStats(stats: { openVacancies: number; placementsThisMonth: number; partnerEmployers: number }) {
  const statVacancies = document.getElementById("statVacancies");
  const statPlacements = document.getElementById("statPlacements");
  const statEmployers = document.getElementById("statEmployers");

  if (statVacancies) statVacancies.textContent = String(stats.openVacancies);
  if (statPlacements) statPlacements.textContent = String(stats.placementsThisMonth);
  if (statEmployers) statEmployers.textContent = String(stats.partnerEmployers);

  const pulseBars = [
    document.getElementById("pulseBar1"),
    document.getElementById("pulseBar2"),
    document.getElementById("pulseBar3"),
    document.getElementById("pulseBar4"),
    document.getElementById("pulseBar5"),
    document.getElementById("pulseBar6"),
    document.getElementById("pulseBar7"),
    document.getElementById("pulseBar8"),
  ];

  const maxValue = Math.max(stats.openVacancies, stats.placementsThisMonth, stats.partnerEmployers, 1);
  const baseHeights = [0.44, 0.68, 0.62, 0.9, 0.72, 1, 0.82, 0.58];
  const weighted = [
    stats.openVacancies,
    stats.placementsThisMonth,
    stats.partnerEmployers,
    stats.openVacancies,
    stats.placementsThisMonth,
    stats.partnerEmployers,
    stats.openVacancies,
    stats.placementsThisMonth,
  ];

  pulseBars.forEach((bar, index) => {
    if (!bar) return;
    const ratio = weighted[index] / maxValue;
    const height = Math.max(12, Math.min(38, 12 + baseHeights[index] * 22 + ratio * 18));
    bar.style.height = `${height}px`;
  });
}

async function refreshHomeStats() {
  try {
    const stats = await api.getPublicStats();
    renderHomeStats(stats);
  } catch {
    // Keep the headline static if the backend is temporarily unreachable.
  }
}

function populateCategoryFilter() {
  const sel = $<HTMLSelectElement>("jobCategoryFilter");
  const selectedCategory = sel.value;
  const cats = [...new Set(vacancies.map((v) => v.category))];
  sel.innerHTML = '<option value="">All Categories</option>' + cats.map((c) => `<option value="${c}">${c}</option>`).join("");
  sel.value = cats.includes(selectedCategory) ? selectedCategory : "";
}

async function refreshVacancies() {
  vacancies = await api.getVacancies();
  populateCategoryFilter();
  renderFeaturedJobs();
  if (document.getElementById("view-jobs")?.classList.contains("active")) {
    renderJobsList();
  }
}

/* Jobs list pagination: keep the grid to a manageable page size instead of dumping
 * every matching vacancy on screen at once. */
const JOBS_PAGE_SIZE = 10;
let currentJobsPage = 1;

/** Called from the search/category filter controls so changing a filter always
 * snaps back to page 1 (staying on, say, page 3 of a now-shorter result set
 * would otherwise show an empty page). */
function jobsFilterChanged() {
  currentJobsPage = 1;
  renderJobsList();
}

function jobsGoToPage(page: number) {
  currentJobsPage = page;
  renderJobsList();
  document.getElementById("jobsListGrid")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderJobsList() {
  const search = ($<HTMLInputElement>("jobSearchInput")?.value || (document.getElementById("heroSearch") as HTMLInputElement | null)?.value || "").toLowerCase();
  const cat = $<HTMLSelectElement>("jobCategoryFilter")?.value || "";
  const sortOrder = $<HTMLSelectElement>("jobSortOrder")?.value || "title";
  const heroSearch = document.getElementById("heroSearch") as HTMLInputElement | null;
  const jobSearchInput = document.getElementById("jobSearchInput") as HTMLInputElement | null;
  if (jobSearchInput && heroSearch && heroSearch.value) {
    jobSearchInput.value = heroSearch.value;
  }

  let filtered = vacancies.filter((v) => {
    const matchesSearch = v.title.toLowerCase().includes(search) || v.employer.toLowerCase().includes(search);
    const matchesCat = !cat || v.category === cat;
    return matchesSearch && matchesCat;
  });

  const canMatch = isVerifiedSeeker(currentUser) && isProfileComplete(currentUser);
  if (canMatch && sortOrder === "match") {
    filtered = [...filtered].sort((a, b) => computeMatchScore(currentUser, b).totalScore - computeMatchScore(currentUser, a).totalScore);
  } else {
    const titleCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    filtered = [...filtered].sort((a, b) => titleCollator.compare(a.title || "", b.title || ""));
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / JOBS_PAGE_SIZE));
  if (currentJobsPage > totalPages) currentJobsPage = totalPages;
  if (currentJobsPage < 1) currentJobsPage = 1;
  const start = (currentJobsPage - 1) * JOBS_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + JOBS_PAGE_SIZE);

  $("jobsCountLabel").textContent = filtered.length
    ? `${filtered.length} vacanc${filtered.length === 1 ? "y" : "ies"} found${canMatch && sortOrder === "match" ? " · sorted by best match" : " · sorted by job title"} · page ${currentJobsPage} of ${totalPages}`
    : "";
  $("jobsListGrid").innerHTML = pageItems.map(jobCard).join("") || `<p class="text-sm" style="color:var(--color-muted)">No vacancies match your search.</p>`;
  $("jobsPagination").innerHTML = jobsPaginationHtml(currentJobsPage, totalPages);
}

/** Simple Back / page-number / Next pager for the jobs list. */
function jobsPaginationHtml(page: number, totalPages: number): string {
  if (totalPages <= 1) return "";
  const btn = (label: string, target: number, disabled: boolean, extraClass = "") =>
    `<button type="button" ${disabled ? "disabled" : `onclick="jobsGoToPage(${target})"`} class="px-3 py-1.5 rounded-lg text-xs font-semibold ${extraClass}" style="${
      disabled ? "opacity:0.4; cursor:default; border:1px solid var(--color-border)" : "border:1px solid var(--color-border)"
    }">${label}</button>`;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1)
    .map(
      (p) =>
        `<button type="button" onclick="jobsGoToPage(${p})" class="w-8 h-8 rounded-lg text-xs font-semibold" style="${
          p === page ? "background:var(--color-primary); color:#fff" : "border:1px solid var(--color-border)"
        }">${p}</button>`
    )
    .join("");
  return `<div class="flex items-center flex-wrap gap-2 mt-6">
    ${btn("&larr; Back", page - 1, page === 1)}
    ${pages}
    ${btn("Next &rarr;", page + 1, page === totalPages)}
  </div>`;
}

/* ================= JOB DETAIL ================= */
function openJob(id: number) {
  const job = vacancies.find((v) => v.id === id);
  if (!job) return;
  const mapCoordinates = validMapCoordinates(job.latitude, job.longitude);
  const alreadyApplied = currentUser && currentApplications().some((a) => a.vacancyId === id);
  const staffReferral = pendingStaffReferrals.find((referral) => referral.vacancy.id === id);
  $("jobDetailContent").innerHTML = `
    <button onclick="nav('jobs')" class="text-sm font-medium mb-6 inline-flex items-center gap-1" style="color:var(--color-primary)">&larr; Back to Jobs</button>
    <div class="grid md:grid-cols-[1fr_260px] gap-6 items-start">
      <div class="card rounded-xl p-8 fade-in">
        <span class="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded" style="background:#DCEAF7; color:#1D5A85">${job.category}</span>
        <h1 class="font-display text-2xl font-semibold mt-3 mb-1">${job.title}</h1>
        <p class="text-sm mb-5" style="color:var(--color-muted)">${job.employer} &middot; ${job.location}</p>
        <div class="grid sm:grid-cols-3 gap-4 mb-6 text-sm">
          <div class="rounded-lg p-3" style="background:var(--color-bg)"><div class="text-[11px] uppercase" style="color:var(--color-muted)">Salary Range</div><div class="font-semibold">${formatSalary(job.salary)}</div></div>
          <div class="rounded-lg p-3" style="background:var(--color-bg)"><div class="text-[11px] uppercase" style="color:var(--color-muted)">Employment Type</div><div class="font-semibold">${job.type}</div></div>
          <div class="rounded-lg p-3" style="background:var(--color-bg)"><div class="text-[11px] uppercase" style="color:var(--color-muted)">Open Slots</div><div class="font-semibold">${job.slots}</div></div>
        </div>
        <h3 class="font-semibold text-sm mb-2">Job Description</h3>
        <p class="text-sm mb-5 leading-relaxed" style="color:var(--color-muted)">${job.description}</p>
        <h3 class="font-semibold text-sm mb-2">Qualifications</h3>
        <ul class="text-sm mb-7 space-y-1.5" style="color:var(--color-muted)">
          ${job.qualification.map((q) => `<li class="flex gap-2"><span style="color:var(--color-accent-dark)">&#10003;</span>${q}</li>`).join("")}
        </ul>
        ${staffReferral ? `<div class="rounded-lg px-4 py-3 text-sm mb-4" style="background:#DCEAF7; color:#1D5A85">PESO Staff referred this vacancy to you on ${staffReferral.createdAt.slice(0, 10)}. Review the details, then choose whether to apply.</div>` : ""}
        ${
          currentUser && currentUser.role !== "job_seeker"
            ? ""
            : alreadyApplied
            ? `<div class="rounded-lg px-4 py-3 text-sm font-medium" style="background:#E4EEDD; color:#3F6B2E">You've already applied to this vacancy. Track its status in <button onclick="nav('dashboard'); dashTab('applications')" class="underline font-semibold">My Applications</button>.</div>`
            : `<button onclick="applyToJob(${job.id})" class="btn-primary px-6 py-3 rounded-lg text-sm font-semibold">${staffReferral ? "Apply for this Referred Job" : "Apply for this Job"}</button>`
        }
      </div>
      <div class="space-y-4">
        ${matchBreakdownHtml(job)}
        <div class="card rounded-xl p-4">
          <h2 class="font-semibold text-sm mb-1">Job Location</h2>
          <p class="text-xs mb-3" style="color:var(--color-muted)">${job.location}</p>
          ${
            mapCoordinates
              ? `<div id="jobLocationMap-${job.id}" class="location-map rounded-lg border" style="height:300px;border-color:var(--color-border)"></div>
                 <a href="https://www.google.com/maps/search/?api=1&query=${mapCoordinates[0]},${mapCoordinates[1]}" target="_blank" rel="noreferrer" class="text-xs font-semibold mt-2 inline-block" style="color:var(--color-primary)">Open larger map</a>`
              : `<p class="text-xs rounded-lg p-3" style="background:var(--color-bg);color:var(--color-muted)">The employer has not selected a map pin for this vacancy.</p>`
          }
        </div>
      </div>
    </div>`;
  nav("jobdetail");
  if (mapCoordinates) {
    requestAnimationFrame(() => mountLocationMap(`jobLocationMap-${job.id}`, mapCoordinates));
  }
}

/* Every field across Sections I-VIII is now required — a seeker who genuinely has
 * nothing to put (no TIN, no training, no work experience, etc.) types "None" rather
 * than leaving it blank, so staff can tell "left blank by mistake" apart from
 * "confirmed not applicable" when they verify the profile. Section IX ("For Use of
 * PESO Only") is filled in by staff, not the seeker, so it's excluded here. Keep this
 * list and PROFILE_REQUIRED_LABELS in sync so the progress indicator on the profile
 * tab always matches what isProfileComplete() checks. */
const PROFILE_REQUIRED_FIELDS: (keyof AuthUser)[] = [
  // I. Personal Information
  "surname", "firstName", "middleName", "suffix", "dateOfBirth", "sex", "religion", "civilStatus",
  "houseStreet", "barangay", "tin", "heightFt", "contactNumber", "email", "disabilityOthers",
  // II. Employment Status
  "employmentSubTypeOthers", "monthsLookingForWork", "terminatedAbroadCountry", "jobSeekerCategoryOthers",
  "ofwCountry", "ofwReturnDate", "householdIdNo",
  // III. Job Preference
  "preferredOccupation1", "preferredOccupation2", "preferredLocalAreas", "preferredOverseasCountries",
  // IV. Educational Background
  "educationLevel", "course", "yearGraduated", "undergradLevelReached", "undergradYearLastAttended",
  // V. Technical/Vocational Training & Eligibility/License
  "technicalTraining",
  // VI. Other Skills & Skills Summary
  "otherSkillsCustom", "skills",
  // VII. Work Experience
  "companyName", "position", "experience",
  // VIII. Requirements/Documents (handled separately — see documentsRequirementMet())
];
const PROFILE_REQUIRED_LABELS: Record<string, string> = {
  surname: "Surname",
  firstName: "First Name",
  middleName: "Middle Name",
  suffix: "Suffix",
  dateOfBirth: "Date of Birth",
  sex: "Sex",
  religion: "Religion",
  civilStatus: "Civil Status",
  houseStreet: "House No. / Street / Village",
  barangay: "Barangay",
  tin: "TIN",
  heightFt: "Height",
  contactNumber: "Contact Number",
  email: "Email",
  disabilityOthers: "Disability",
  employmentSubTypeOthers: "Self-employed Type (if Others)",
  monthsLookingForWork: "Months Looking for Work",
  terminatedAbroadCountry: "Terminated Abroad Country",
  jobSeekerCategoryOthers: "Jobseeker Category (if Others)",
  ofwCountry: "Latest Country of Deployment",
  ofwReturnDate: "Month/Year Returned to PH",
  householdIdNo: "Household ID No.",
  preferredOccupation1: "Preferred Occupation 1",
  preferredOccupation2: "Preferred Occupation 2",
  preferredLocalAreas: "Preferred Work Location (Local)",
  preferredOverseasCountries: "Preferred Work Location (Overseas)",
  educationLevel: "Education Level",
  course: "Course",
  yearGraduated: "Year Graduated",
  undergradLevelReached: "Undergraduate Level Reached",
  undergradYearLastAttended: "Undergraduate Year Last Attended",
  technicalTraining: "Training/Skills Summary",
  otherSkillsCustom: "Other Skills (if Others)",
  skills: "Skills Summary",
  companyName: "Most Recent Company Name",
  position: "Position",
  experience: "Experience Summary",
};
const DOCUMENTS_LABEL = "Requirements/Documents (upload or mark None)";

/** Section VIII is fulfilled either by uploading at least one document, or by the
 * seeker explicitly declaring they have none to submit (rather than the field just
 * being left blank). */
function documentsRequirementMet(): boolean {
  return currentDocuments().length > 0 || currentUser?.noDocumentsDeclared === "Yes";
}

function isProfileComplete(u: AuthUser | null): boolean {
  if (!u) return false;
  return PROFILE_REQUIRED_FIELDS.every((k) => u[k] && String(u[k]).trim() !== "") && documentsRequirementMet();
}

/** How many of the required fields are filled in (including Section VIII), plus which
 * ones are still missing — used to render the progress indicator at the top of the
 * profile tab. */
function profileCompletionStatus(u: AuthUser | null): { filled: number; total: number; missing: string[] } {
  const total = PROFILE_REQUIRED_FIELDS.length + 1; // +1 for Section VIII
  if (!u) return { filled: 0, total, missing: [...PROFILE_REQUIRED_FIELDS.map((k) => PROFILE_REQUIRED_LABELS[k]), DOCUMENTS_LABEL] };
  const missing = PROFILE_REQUIRED_FIELDS.filter((k) => !u[k] || String(u[k]).trim() === "").map((k) => PROFILE_REQUIRED_LABELS[k]);
  if (!documentsRequirementMet()) missing.push(DOCUMENTS_LABEL);
  return { filled: total - missing.length, total, missing };
}

function scrollToProfileField(fieldId: string): void {
  requestAnimationFrame(() => {
    const field = document.getElementById(fieldId);
    if (!field) return;
    field.scrollIntoView({ behavior: "smooth", block: "center" });
    if (field instanceof HTMLElement) {
      field.focus({ preventScroll: true });
      field.classList.add("profile-missing-field");
      window.setTimeout(() => field.classList.remove("profile-missing-field"), 1800);
    }
  });
}

async function applyToJob(id: number, keepDetailsOpen = false, stayOnApplications = false) {
  if (!currentUser) {
    showToast("Please log in to apply.");
    nav("login");
    return;
  }
  if (currentUser.role !== "job_seeker") {
    showToast("Only Job Seeker accounts can apply for jobs.");
    return;
  }
  if (!isVerifiedSeeker(currentUser)) {
    showToast("Your profile must be verified by PESO Staff before job matching and job applications become available.");
    nav("dashboard");
    dashTab("profile");
    return;
  }
  if (!isProfileComplete(currentUser)) {
    showToast("Please complete your Jobseeker Profile (NSRP Form) before applying.");
    nav("dashboard");
    dashTab("profile");
    return;
  }
  try {
    const app = await api.applyToJob(id);
    applications.unshift(app);
    pendingStaffReferrals = pendingStaffReferrals.filter((referral) => referral.vacancy.id !== id);
    showToast("Application submitted! You'll be notified as PESO reviews it.");
    if (keepDetailsOpen) openVacancyDetailsModal(id);
    else if (stayOnApplications) dashTabInner("applications");
    else openJob(id);
  } catch (err) {
    showToast(errMsg(err, "Could not submit your application."));
  }
}

async function cancelStaffReferralAction(referralId: number) {
  if (!window.confirm("Cancel this PESO job referral? It will be removed from Staff Referrals.")) return;
  try {
    await api.cancelStaffReferral(referralId);
    pendingStaffReferrals = pendingStaffReferrals.filter((referral) => referral.id !== referralId);
    closeVacancyDetailModal();
    showToast("Job referral cancelled.");
    if (currentUser?.role === "job_seeker" && currentDashTab === "referrals") {
      dashTabInner("referrals");
    }
  } catch (err) {
    showToast(errMsg(err, "Could not cancel this job referral."));
  }
}

/* ================= DASHBOARD ================= */
function dashTab(tab: string) {
  guardUnsavedProfile(() => {
    if (currentUser?.role === "staff" && tab !== currentDashTab) {
      clearStaffReviewDetail(currentDashTab);
    }
    if (currentUser?.role === "admin" && tab !== currentDashTab) {
      if (currentDashTab === "seekers") {
        adminSeekerDetailEmail = null;
        adminSeekerDetail = null;
        adminSeekerDetailReturnToEmployer = null;
        adminSeekerDetailReturnToInventory = false;
      }
      if (currentDashTab === "employers") {
        adminEmployerDetailEmail = null;
        adminEmployerDetail = null;
      }
    }
    dashTabInner(tab);
    if (currentUser?.role === "job_seeker" && tab === "referrals") {
      refreshPendingStaffReferrals().then(() => {
        if (currentUser?.role === "job_seeker" && currentDashTab === "referrals") dashTabInner("referrals");
      }).catch((err) => {
        showToast(errMsg(err, "Could not refresh PESO job referrals."));
      });
    }
  });
}

/** Tabs shown in the dashboard sidebar, per role. */
function tabsForRole(role: string): { key: string; label: string }[] {
  if (role === "employer") {
    return [
      { key: "overview", label: "Overview" },
      { key: "profile", label: "Establishment Profile" },
      { key: "vacancies", label: "Job Vacancies" },
      { key: "applications", label: "Applications" },
      { key: "notifications", label: "Notifications" },
    ];
  }
  if (role === "staff") {
    return [
      { key: "overview", label: "Overview" },
      { key: "seekers", label: "Job Seeker Verification" },
      { key: "employers", label: "Employer Verification" },
      { key: "vacancies", label: "Vacancy Approvals" },
      { key: "refer", label: "Refer Seeker" },
      { key: "applications", label: "Application Review" },
    ];
  }
  if (role === "admin") {
    return [
      { key: "overview", label: "Overview" },
      { key: "seekers", label: "Job Seekers" },
      { key: "employers", label: "Employers" },
      { key: "vacancyInventory", label: "Vacancy Inventory" },
      { key: "reports", label: "Reports" },
      { key: "applications", label: "Applications" },
      { key: "staffmgmt", label: "Staff Accounts" },
      { key: "adminmgmt", label: "Admin Accounts" },
      { key: "activity", label: "Activity Log" },
    ];
  }
  return [
    { key: "overview", label: "Overview" },
    { key: "profile", label: "My Profile" },
    { key: "referrals", label: "Staff Referrals" },
    { key: "applications", label: "My Applications" },
    { key: "notifications", label: "Notifications" },
  ];
}
const ROLE_LABELS: Record<string, string> = { job_seeker: "Job Seeker", employer: "Employer", staff: "PESO Staff", admin: "Administrator" };

function renderDashNav(role: string, activeTab: string) {
  const tabs = tabsForRole(role);
  const activeLabel = tabs.find((tab) => tab.key === activeTab)?.label ?? tabs[0]?.label ?? "Overview";
  $("dashNav").innerHTML = `
    <button type="button" class="dash-nav-trigger" onclick="toggleDashMenu()" aria-expanded="false" aria-controls="dashNavMenu">
      <span class="dash-nav-current">${activeLabel}</span>
      <span class="dash-nav-chevron" aria-hidden="true"></span>
    </button>
    <div id="dashNavMenu" class="dash-nav-menu">
      ${tabs
    .map(
      (t) => `
      <button onclick="closeDashMenu(); dashTab('${t.key}')" class="dash-tab-btn w-full text-left px-3 py-2 rounded-lg" data-tab="${t.key}" style="background:${t.key === activeTab ? "var(--color-primary)" : "transparent"}; color:${t.key === activeTab ? "#fff" : "var(--color-text)"}">
        ${t.label}${t.key === "notifications" ? ` <span id="notifBadge" class="hidden ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white" style="background:var(--color-warn)"></span>` : ""}
      </button>`,
    )
    .join("")}
    </div>`;
}

function toggleDashMenu() {
  const nav = $("dashNav");
  const trigger = nav.querySelector<HTMLButtonElement>(".dash-nav-trigger");
  const isOpen = nav.classList.toggle("is-open");
  trigger?.setAttribute("aria-expanded", String(isOpen));
}

function closeDashMenu() {
  const nav = $("dashNav");
  nav.classList.remove("is-open");
  nav.querySelector<HTMLButtonElement>(".dash-nav-trigger")?.setAttribute("aria-expanded", "false");
}

function renderDashboardAvatar() {
  const avatar = $("dashAvatarInitial");
  if (!currentAvatarData) {
    avatar.replaceChildren(document.createTextNode(currentUser?.name?.charAt(0) || "?"));
    return;
  }
  const image = document.createElement("img");
  image.src = currentAvatarData;
  image.alt = "Profile photo";
  image.className = "w-full h-full object-cover";
  avatar.replaceChildren(image);
}

async function changeAvatar(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  if (!file.type.startsWith("image/")) {
    showToast("Choose an image file for your profile photo.");
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showToast("Choose an image smaller than 8 MB.");
    return;
  }

  try {
    const source = await createImageBitmap(file);
    const scale = Math.min(1, 320 / Math.max(source.width, source.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process this image.");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close();

    const avatarData = canvas.toDataURL("image/jpeg", 0.82);
    if (Math.ceil((avatarData.length * 3) / 4) > 1024 * 1024) {
      showToast("This photo is too large after processing. Choose a smaller image.");
      return;
    }
    currentAvatarData = await api.updateAvatar(avatarData);
    renderDashboardAvatar();
    renderNavAuth();
    showToast("Profile photo updated.");
  } catch (err) {
    showToast(errMsg(err, "Could not update your profile photo."));
  }
}

function dashTabInner(tab: string) {
  if (!currentUser) {
    navInner("login");
    return;
  }
  currentDashTab = tab;
  const role = currentUser.role || "job_seeker";
  renderDashNav(role, tab);
  $("dashUserName").textContent = currentUser.name ?? "";
  $("dashUserRole").textContent = ROLE_LABELS[role] ?? "Job Seeker";
  renderDashboardAvatar();
  const badge = document.getElementById("notifBadge");
  if (badge) {
    const unread = currentNotifications().filter((n) => !n.read).length;
    if (unread > 0) {
      badge.textContent = String(unread);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  if (role === "employer") return renderEmployerDash(tab);
  if (role === "staff") return renderStaffDash(tab);
  if (role === "admin") return renderAdminDash(tab);

  const content = $("dashContent");
  if (tab === "overview") {
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Welcome, ${currentUser.name?.split(" ")[0] ?? ""}</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Here's a quick snapshot of your job search.</p>
      ${verificationStatusCardHtml(currentUser)}
      <div class="grid sm:grid-cols-3 gap-4 mb-8 stagger-grid">
        <div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${currentApplications().length}</div><div class="text-xs" style="color:var(--color-muted)">Applications Submitted</div></div>
        <div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${currentApplications().filter((a) => a.status === "waiting" || a.status === "hired").length}</div><div class="text-xs" style="color:var(--color-muted)">In Employer Review</div></div>
        <div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${currentNotifications().filter((n) => !n.read).length}</div><div class="text-xs" style="color:var(--color-muted)">Unread Notifications</div></div>
      </div>
      <h3 class="font-semibold text-sm mb-3">Recommended For You</h3>
      ${
        isVerifiedSeeker(currentUser) && isProfileComplete(currentUser)
          ? `<p class="text-xs mb-3" style="color:var(--color-muted)">Ranked by your Match Score (Education 40% + Skills 35% + Experience 25%).</p>`
          : `<div class="rounded-lg px-4 py-3 text-xs font-medium mb-3" style="background:#FCEFD9; color:#8A5A0F">Complete and get your profile verified by PESO Staff to unlock personalized job matching and see your Match Score on every listing. <button onclick="dashTab('profile')" class="underline font-semibold">Go to My Profile &rarr;</button></div>`
      }
      <div class="grid sm:grid-cols-3 gap-4 mb-8 stagger-grid">${(isVerifiedSeeker(currentUser) && isProfileComplete(currentUser) ? [...vacancies].sort((a, b) => computeMatchScore(currentUser, b).totalScore - computeMatchScore(currentUser, a).totalScore) : vacancies).slice(0, 3).map(jobCard).join("")}</div>
      <h3 class="font-semibold text-sm mb-3">Recent Applications</h3>
      <div class="space-y-3 stagger-grid">${currentApplications().slice(0, 3).map(appRow).join("")}</div>
    `;
  }
  if (tab === "profile") {
    profileDirty = false;
    const u = currentUser;
    // Rule 2 / Rule 7: a Pending Verification / Verified / Rejected profile is locked —
    // show the read-only verification-status view instead of the editable NSRP form.
    if (u.verificationStatus !== "draft" && u.verificationStatus !== "returned_for_completion") {
      content.innerHTML = lockedProfileStatusHtml(u);
      return;
    }
    const complete = isProfileComplete(u);
    const status = profileCompletionStatus(u);
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Jobseeker Profile</h1>
      <p class="text-sm mb-4" style="color:var(--color-muted)">Based on DOLE-PESO's National Skills Registration Program (NSRP) Form. <strong>All fields marked with * are required</strong> to submit your profile for verification. If something doesn't apply to you (e.g. you have no training, no work experience, or no documents yet), just type <strong>"None"</strong> instead of leaving it blank &mdash; PESO staff need to see a confirmed answer, not an empty field, when they verify your profile.</p>
      ${
        u.verificationStatus === "returned_for_completion"
          ? `<div class="rounded-lg px-4 py-3 text-sm font-medium mb-4" style="background:#FBE3E1; color:#9B2C22">
              <p class="font-semibold mb-1">&#9888; Action Required: Your profile was returned by PESO Staff</p>
              <p><strong>Staff Remarks:</strong> ${u.verificationRemarks || "See missing requirements below."}</p>
              <p class="mt-1 text-xs">Please correct the information above and click <strong>Submit for Verification</strong> below to send it back to PESO Staff.</p>
            </div>`
          : ""
      }
      <div class="rounded-lg px-4 py-3 text-sm font-medium mb-6" style="background:${complete ? "#E4EEDD" : "#FCEFD9"}; color:${complete ? "#1F6B3F" : "#8A5A0F"}">
        <div class="flex items-center justify-between gap-3 mb-1">
          <span>${complete ? "&#10003; Your profile is complete and ready to submit for verification." : `&#9888; ${status.filled} of ${status.total} required fields completed.`}</span>
          <span class="text-xs font-semibold whitespace-nowrap">${status.filled}/${status.total}</span>
        </div>
        <div class="w-full h-1.5 rounded-full overflow-hidden" style="background:rgba(0,0,0,0.08)">
          <div class="h-full rounded-full" style="width:${Math.round((status.filled / status.total) * 100)}%; background:${complete ? "#1F6B3F" : "#8A5A0F"}"></div>
        </div>
        ${!complete ? `<p class="text-xs mt-2">Still missing: ${status.missing.join(", ")}.</p>` : ""}
      </div>
      <form id="profileForm" onsubmit="event.preventDefault(); saveProfile();" class="space-y-6">

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">I. Personal Information</h3>
          <div class="grid sm:grid-cols-3 gap-3 mb-3">
            <div><label for="pSurname" class="text-xs font-semibold block mb-1.5">Surname *</label><input id="pSurname" value="${u.surname}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pFirstName" class="text-xs font-semibold block mb-1.5">First Name *</label><input id="pFirstName" value="${u.firstName}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pMiddleName" class="text-xs font-semibold block mb-1.5">Middle Name *</label><input id="pMiddleName" value="${u.middleName}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="grid sm:grid-cols-3 gap-3 mb-3">
            <div><label for="pSuffix" class="text-xs font-semibold block mb-1.5">Suffix *</label><input id="pSuffix" value="${u.suffix ?? ""}" placeholder="Sr., Jr., III, or None" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pDob" class="text-xs font-semibold block mb-1.5">Date of Birth *</label><input id="pDob" type="date" value="${u.dateOfBirth}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pSex" class="text-xs font-semibold block mb-1.5">Sex *</label><select id="pSex" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option value="">Select</option><option ${u.sex === "Male" ? "selected" : ""}>Male</option><option ${u.sex === "Female" ? "selected" : ""}>Female</option></select></div>
          </div>
          <div class="grid sm:grid-cols-3 gap-3 mb-3">
            <div><label for="pReligion" class="text-xs font-semibold block mb-1.5">Religion *</label><input id="pReligion" value="${u.religion ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pCivilStatus" class="text-xs font-semibold block mb-1.5">Civil Status *</label><select id="pCivilStatus" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option value="">Select</option>${["Single", "Married", "Widowed"].map((s) => `<option ${u.civilStatus === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
            <div><label for="pTin" class="text-xs font-semibold block mb-1.5">TIN *</label><input id="pTin" value="${u.tin ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="grid sm:grid-cols-2 gap-3 mb-3">
            <div><label for="pHouseStreet" class="text-xs font-semibold block mb-1.5">House No. / Street / Village *</label><input id="pHouseStreet" value="${u.houseStreet}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pBarangay" class="text-xs font-semibold block mb-1.5">Barangay *</label><input id="pBarangay" value="${u.barangay}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="grid sm:grid-cols-3 gap-3 mb-3">
            <div><label for="pHeight" class="text-xs font-semibold block mb-1.5">Height (ft.) *</label><input id="pHeight" value="${u.heightFt ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pContact" class="text-xs font-semibold block mb-1.5">Contact Number *</label><input id="pContact" value="${u.contactNumber}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pEmail" class="text-xs font-semibold block mb-1.5">Email *</label><input id="pEmail" value="${u.email}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div>
            <label class="text-xs font-semibold block mb-2">Disability (if any)</label>
            <div class="grid sm:grid-cols-3 gap-2 mb-2">
              ${DISABILITY_TYPES.map((s) => `<label class="flex items-center gap-2 text-xs"><input type="checkbox" class="pDisability" value="${s}" ${(u.disabilityTypes ?? []).includes(s) ? "checked" : ""}> ${s}</label>`).join("")}
            </div>
            <label for="pDisabilityOthers" class="text-xs font-semibold block mb-1.5">If Others, please specify *</label>
            <input id="pDisabilityOthers" value="${u.disabilityOthers ?? ""}" placeholder="Type None if no disability" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
          </div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">II. Employment Status</h3>
          <div class="grid sm:grid-cols-3 gap-3 mb-3">
            <div><label for="pEmploymentStatus" class="text-xs font-semibold block mb-1.5">Current Status</label><select id="pEmploymentStatus" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">${["Unemployed", "Employed", "Self-employed", "New Entrant/Fresh Graduate"].map((s) => `<option ${u.employmentStatus === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
            <div><label for="pEmploymentSubType" class="text-xs font-semibold block mb-1.5">If Self-employed, Type</label><select id="pEmploymentSubType" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option value="">N/A</option>${SELF_EMPLOYED_SUBTYPES.map((s) => `<option ${u.employmentSubType === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
            <div><label for="pEmploymentSubTypeOthers" class="text-xs font-semibold block mb-1.5">If Others, specify *</label><input id="pEmploymentSubTypeOthers" value="${u.employmentSubTypeOthers ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="mb-3"><label for="pMonthsLooking" class="text-xs font-semibold block mb-1.5">How long have you been looking for work? (months) *</label><input id="pMonthsLooking" value="${u.monthsLookingForWork ?? ""}" placeholder="Type None if not applicable" class="w-full sm:w-40 border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          <div class="mb-3">
            <label class="text-xs font-semibold block mb-2">Jobseeker Category</label>
            <div class="grid sm:grid-cols-2 gap-2 mb-2">
              ${JOBSEEKER_CATEGORIES.map((s) => `<label class="flex items-center gap-2 text-xs"><input type="checkbox" class="pJobSeekerCategory" value="${s}" ${(u.jobSeekerCategory ?? []).includes(s) ? "checked" : ""}> ${s}</label>`).join("")}
            </div>
            <div class="grid sm:grid-cols-2 gap-3">
              <input id="pTerminatedAbroadCountry" value="${u.terminatedAbroadCountry ?? ""}" placeholder="If terminated abroad, specify country, or None" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
              <input id="pJobSeekerCategoryOthers" value="${u.jobSeekerCategoryOthers ?? ""}" placeholder="If Others, please specify, or None" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
            </div>
          </div>
          <div class="grid sm:grid-cols-3 gap-3 mb-3">
            <div><label for="pOFW" class="text-xs font-semibold block mb-1.5">Former OFW?</label><select id="pOFW" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option ${u.isOFW === "No" ? "selected" : ""}>No</option><option ${u.isOFW === "Yes" ? "selected" : ""}>Yes</option></select></div>
            <div><label for="pOfwCountry" class="text-xs font-semibold block mb-1.5">Latest Country of Deployment *</label><input id="pOfwCountry" value="${u.ofwCountry ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pOfwReturnDate" class="text-xs font-semibold block mb-1.5">Month/Year Returned to PH *</label><input id="pOfwReturnDate" value="${u.ofwReturnDate ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="grid sm:grid-cols-2 gap-3">
            <div><label for="p4Ps" class="text-xs font-semibold block mb-1.5">4Ps Beneficiary?</label><select id="p4Ps" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option ${u.is4Ps === "No" ? "selected" : ""}>No</option><option ${u.is4Ps === "Yes" ? "selected" : ""}>Yes</option></select></div>
            <div><label for="pHouseholdId" class="text-xs font-semibold block mb-1.5">Household ID No. *</label><input id="pHouseholdId" value="${u.householdIdNo ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">III. Job Preference</h3>
          <div class="grid sm:grid-cols-2 gap-3 mb-3">
            <div><label for="pOcc1" class="text-xs font-semibold block mb-1.5">Preferred Occupation 1 *</label><input id="pOcc1" value="${u.preferredOccupation1}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pOcc2" class="text-xs font-semibold block mb-1.5">Preferred Occupation 2 *</label><input id="pOcc2" value="${u.preferredOccupation2}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="grid sm:grid-cols-2 gap-3 mb-3">
            <div><label for="pWorkType" class="text-xs font-semibold block mb-1.5">Work Type</label><select id="pWorkType" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option ${u.workType === "Full-time" ? "selected" : ""}>Full-time</option><option ${u.workType === "Part-time" ? "selected" : ""}>Part-time</option></select></div>
            <div><label for="pWorkLocation" class="text-xs font-semibold block mb-1.5">Preferred Location</label><select id="pWorkLocation" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option ${u.workLocation === "Local" ? "selected" : ""}>Local</option><option ${u.workLocation === "Overseas" ? "selected" : ""}>Overseas</option></select></div>
          </div>
          <div class="grid sm:grid-cols-2 gap-3 mb-4">
            <div>
              <label class="text-xs font-semibold block mb-1.5">Preferred Work Location &mdash; Local (up to 3 cities/municipalities) *</label>
              <div class="space-y-2">
                ${[0, 1, 2].map((i) => `<input id="pLocal${i + 1}" value="${(u.preferredLocalAreas ?? [])[i] ?? ""}" placeholder="${i === 0 ? "Type None if not applicable" : ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">`).join("")}
              </div>
            </div>
            <div>
              <label class="text-xs font-semibold block mb-1.5">Preferred Work Location &mdash; Overseas (up to 3 countries) *</label>
              <div class="space-y-2">
                ${[0, 1, 2].map((i) => `<input id="pOverseas${i + 1}" value="${(u.preferredOverseasCountries ?? [])[i] ?? ""}" placeholder="${i === 0 ? "Type None if not applicable" : ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">`).join("")}
              </div>
            </div>
          </div>
          <div>
            <label class="text-xs font-semibold block mb-2">Language / Dialect Proficiency</label>
            <div class="overflow-x-auto">
              <table class="w-full text-xs border-collapse">
                <thead><tr>
                  <th class="text-left p-1.5 border-b" style="border-color:var(--color-border)">Language</th>
                  ${LANGUAGE_SKILLS.map((sk) => `<th class="p-1.5 border-b text-center" style="border-color:var(--color-border)">${sk}</th>`).join("")}
                </tr></thead>
                <tbody>
                  ${LANGUAGES.map(
                    (lang) => `<tr>
                      <td class="p-1.5 border-b font-medium" style="border-color:var(--color-border)">${lang}</td>
                      ${LANGUAGE_SKILLS.map((sk) => `<td class="p-1.5 border-b text-center" style="border-color:var(--color-border)"><input type="checkbox" class="pLang" data-lang="${lang}" data-skill="${sk}" ${(u.languageProficiency?.[lang] ?? []).includes(sk) ? "checked" : ""}></td>`).join("")}
                    </tr>`,
                  ).join("")}
                  <tr>
                    <td class="p-1.5 border-b" style="border-color:var(--color-border)"><input id="pLangOthersName" value="${Object.keys(u.languageProficiency ?? {}).find((k) => !LANGUAGES.includes(k)) ?? ""}" placeholder="Others" class="w-full border rounded px-2 py-1 text-xs" style="border-color:var(--color-border)"></td>
                    ${LANGUAGE_SKILLS.map((sk) => `<td class="p-1.5 border-b text-center" style="border-color:var(--color-border)"><input type="checkbox" class="pLangOthers" data-skill="${sk}" ${(u.languageProficiency?.[Object.keys(u.languageProficiency ?? {}).find((k) => !LANGUAGES.includes(k)) ?? ""] ?? []).includes(sk) ? "checked" : ""}></td>`).join("")}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">IV. Educational Background <span class="font-normal text-xs" style="color:var(--color-muted)">&mdash; 40% of Match Score</span></h3>
          <div class="mb-3"><label for="pInSchool" class="text-xs font-semibold block mb-1.5">Currently in school?</label><select id="pInSchool" class="w-full sm:w-40 border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option ${u.currentlyInSchool === "No" ? "selected" : ""}>No</option><option ${u.currentlyInSchool === "Yes" ? "selected" : ""}>Yes</option></select></div>
          <div class="grid sm:grid-cols-3 gap-3 mb-3">
            <div><label for="pEdLevel" class="text-xs font-semibold block mb-1.5">Highest Level *</label><select id="pEdLevel" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option value="">Select</option>${["Elementary", "Secondary", "Senior High", "Tertiary", "Graduate Studies", "Post-graduate"].map((s) => `<option ${u.educationLevel === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
            <div><label for="pCourse" class="text-xs font-semibold block mb-1.5">Course / Strand *</label><input id="pCourse" value="${u.course}" placeholder="e.g. BS Office Administration" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pYearGrad" class="text-xs font-semibold block mb-1.5">Year Graduated *</label><input id="pYearGrad" value="${u.yearGraduated}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="grid sm:grid-cols-2 gap-3">
            <div><label for="pUndergradLevel" class="text-xs font-semibold block mb-1.5">If undergraduate: Level reached *</label><input id="pUndergradLevel" value="${u.undergradLevelReached ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pUndergradYear" class="text-xs font-semibold block mb-1.5">Year last attended *</label><input id="pUndergradYear" value="${u.undergradYearLastAttended ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">V. Technical/Vocational Training &amp; Eligibility/License <span class="font-normal text-xs" style="color:var(--color-muted)">&mdash; part of Match Score</span></h3>
          <div class="mb-3"><label for="pTraining" class="text-xs font-semibold block mb-1.5">Training/Skills Summary (used for job matching) *</label><input id="pTraining" value="${u.technicalTraining}" placeholder="e.g. TESDA NC II Computer Servicing, or None" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          <label class="text-xs font-semibold block mb-2">Training/Vocational Course Taken</label>
          <div class="space-y-3 mb-4">
            ${[0, 1].map((i) => {
              const t = (u.trainings ?? [])[i] ?? ({} as Partial<TrainingEntry>);
              return `<div class="grid sm:grid-cols-5 gap-2 p-2 rounded-lg" style="background:var(--color-bg)">
                <input id="pTrainCourse${i + 1}" value="${t.course ?? ""}" placeholder="Course" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pTrainInstitution${i + 1}" value="${t.institution ?? ""}" placeholder="Institution" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pTrainHours${i + 1}" value="${t.hours ?? ""}" placeholder="Hours" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pTrainSkills${i + 1}" value="${t.skillsAcquired ?? ""}" placeholder="Skills acquired" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pTrainCerts${i + 1}" value="${t.certificates ?? ""}" placeholder="Certificates received" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
              </div>`;
            }).join("")}
          </div>
          <label class="text-xs font-semibold block mb-2">Eligibility (Civil Service)</label>
          <div class="space-y-2 mb-4">
            ${[0, 1, 2].map((i) => {
              const e = (u.eligibilities ?? [])[i] ?? ({} as Partial<EligibilityEntry>);
              return `<div class="grid sm:grid-cols-2 gap-2">
                <input id="pElig${i + 1}Name" value="${e.name ?? ""}" placeholder="Eligibility" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pElig${i + 1}Date" value="${e.dateTaken ?? ""}" placeholder="Date taken" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
              </div>`;
            }).join("")}
          </div>
          <label class="text-xs font-semibold block mb-2">Professional License (PRC)</label>
          <div class="space-y-2">
            ${[0, 1].map((i) => {
              const l = (u.licenses ?? [])[i] ?? ({} as Partial<LicenseEntry>);
              return `<div class="grid sm:grid-cols-2 gap-2">
                <input id="pLicense${i + 1}Name" value="${l.name ?? ""}" placeholder="License" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pLicense${i + 1}Valid" value="${l.validUntil ?? ""}" placeholder="Valid until" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
              </div>`;
            }).join("")}
          </div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">VI. Other Skills &amp; Skills Summary <span class="font-normal text-xs" style="color:var(--color-muted)">&mdash; 35% of Match Score</span></h3>
          <div class="mb-3">
            <label class="text-xs font-semibold block mb-2">Other Skills Acquired (no certificate needed)</label>
            <div class="grid sm:grid-cols-3 gap-2 mb-2">
              ${OTHER_SKILLS_LIST.map((s) => `<label class="flex items-center gap-2 text-xs"><input type="checkbox" class="pOtherSkill" value="${s}" ${u.otherSkills.includes(s) ? "checked" : ""}> ${s}</label>`).join("")}
            </div>
            <label for="pOtherSkillsCustom" class="text-xs font-semibold block mb-1.5">Others, please specify *</label>
            <input id="pOtherSkillsCustom" value="${u.otherSkillsCustom ?? ""}" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
          </div>
          <div><label for="pSkills" class="text-xs font-semibold block mb-1.5">Skills Summary (for job matching) *</label><textarea id="pSkills" rows="2" placeholder="Type None if not applicable" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">${u.skills}</textarea></div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">VII. Work Experience <span class="font-normal text-xs" style="color:var(--color-muted)">&mdash; 25% of Match Score, limit 10 years, most recent first</span></h3>
          <div class="grid sm:grid-cols-2 gap-3 mb-3">
            <div><label for="pCompany" class="text-xs font-semibold block mb-1.5">Most Recent Company Name *</label><input id="pCompany" value="${u.companyName}" placeholder="Type None if no work experience" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="pPosition" class="text-xs font-semibold block mb-1.5">Position *</label><input id="pPosition" value="${u.position}" placeholder="Type None if no work experience" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
          <div class="mb-4"><label for="pExperience" class="text-xs font-semibold block mb-1.5">Experience Summary (for job matching) *</label><textarea id="pExperience" rows="2" placeholder="e.g. 2 years as a sales clerk, or None" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">${u.experience}</textarea></div>
          <label class="text-xs font-semibold block mb-2">Employment History (up to 2 entries)</label>
          <div class="space-y-3">
            ${[0, 1].map((i) => {
              const w = (u.workExperiences ?? [])[i] ?? ({} as Partial<WorkExperienceEntry>);
              return `<div class="grid sm:grid-cols-3 gap-2 p-2 rounded-lg" style="background:var(--color-bg)">
                <input id="pWork${i + 1}Company" value="${w.companyName ?? ""}" placeholder="Company name" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pWork${i + 1}Address" value="${w.address ?? ""}" placeholder="Address (city/municipality)" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pWork${i + 1}Position" value="${w.position ?? ""}" placeholder="Position" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <select id="pWork${i + 1}Status" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)"><option value="">Status</option>${["Permanent", "Contractual", "Part-time", "Probationary"].map((s) => `<option ${w.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
                <input id="pWork${i + 1}From" value="${w.dateFrom ?? ""}" placeholder="From (mm/dd/yyyy)" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
                <input id="pWork${i + 1}To" value="${w.dateTo ?? ""}" placeholder="To (mm/dd/yyyy)" class="border rounded-lg px-2 py-1.5 text-xs" style="border-color:var(--color-border)">
              </div>`;
            }).join("")}
          </div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">VIII. Requirements / Documents *</h3>
          <input id="pDocInput" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" class="hidden" onchange="handleDocUpload(this.files)" ${u.noDocumentsDeclared === "Yes" ? "disabled" : ""}>
          <button type="button" onclick="document.getElementById('pDocInput').click()" ${u.noDocumentsDeclared === "Yes" ? "disabled" : ""} class="w-full border-2 border-dashed rounded-lg p-6 text-center text-xs hover:bg-black/[0.02] transition-colors disabled:opacity-50" style="border-color:var(--color-border); color:var(--color-muted)">
            Drag files here or <span class="font-semibold" style="color:var(--color-primary)">browse</span> &mdash; Resume, Valid ID, Birth Certificate
          </button>
          <div id="pDocList" class="mt-3 space-y-2">${docListHtml()}</div>
          <p class="text-[11px] mt-3 mb-3" style="color:var(--color-muted)">Files are uploaded straight to the PESO server as you attach them (8MB limit each) &mdash; no need to click Save Profile for these.</p>
          <label class="flex items-center gap-2 text-xs font-medium pt-3" style="border-top:1px solid var(--color-border)">
            <input type="checkbox" id="pNoDocuments" ${u.noDocumentsDeclared === "Yes" ? "checked" : ""} onchange="toggleNoDocuments()">
            I don't have any documents to submit right now
          </label>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-4" style="color:var(--color-primary)">IX. For Use of PESO Only</h3>
          <div class="mb-3">
            <label class="text-xs font-semibold block mb-2">Referred to</label>
            <div class="grid sm:grid-cols-3 gap-2 mb-2">
              ${REFERRED_TO_OPTIONS.map((s) => `<label class="flex items-center gap-2 text-xs"><input type="checkbox" class="pReferredTo" value="${s}" ${(u.referredTo ?? []).includes(s) ? "checked" : ""}> ${s}</label>`).join("")}
            </div>
            <input id="pReferredToOthers" value="${u.referredToOthers ?? ""}" placeholder="Others, specify" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
          </div>
          <div><label for="pAppType" class="text-xs font-semibold block mb-1.5">Application Type</label><select id="pAppType" class="w-full sm:w-48 border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"><option ${(u.applicationType ?? "New Applicant") === "New Applicant" ? "selected" : ""}>New Applicant</option><option ${u.applicationType === "Renewal" ? "selected" : ""}>Renewal</option></select></div>
        </div>

        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-2" style="color:var(--color-primary)">Certification/Authorization</h3>
          <p class="text-xs" style="color:var(--color-muted)">This is to certify that all data/information I have provided in this form are true to the best of my knowledge. This is also to authorize DOLE to include my profile in the PESO Employment Information System and use my personal information for facilitation. I am also aware that DOLE is not obliged to seek employment on my behalf.</p>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button type="submit" class="btn-outline px-6 py-2.5 rounded-lg text-sm font-semibold">Save Progress</button>
          <button type="button" onclick="doSubmitProfileForVerification()" class="btn-primary px-6 py-2.5 rounded-lg text-sm font-semibold" ${complete ? "" : "disabled style=\"opacity:0.5; cursor:not-allowed\""}>
            ${u.verificationStatus === "returned_for_completion" ? "Resubmit for Verification" : "Submit for Verification"}
          </button>
          ${!complete ? `<span class="text-xs" style="color:var(--color-muted)">Complete every required field above to submit.</span>` : ""}
        </div>
      </form>
    `;
  }
  if (tab === "applications") {
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">My Applications</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Jobs you applied to directly from Find Jobs appear here. Jobs applied to after a PESO referral are kept under Staff Referrals.</p>
      <div class="space-y-3 stagger-grid">${currentApplications().length ? currentApplications().map(appRow).join("") : `<p class="text-sm" style="color:var(--color-muted)">You haven't applied to any jobs yet.</p>`}</div>
    `;
  }
  if (tab === "referrals") {
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Staff Referrals</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Jobs recommended by PESO Staff appear here. Review the details and choose whether to apply. These are not applications until you apply.</p>
      <div class="space-y-3 stagger-grid">${pendingStaffReferrals.length ? pendingStaffReferrals.map((referral) => `
        <div class="card rounded-xl p-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="font-semibold text-sm">${referral.vacancy.title}</h3>
            <p class="text-xs mt-1" style="color:var(--color-muted)">${referral.vacancy.employer} &middot; ${referral.vacancy.location} &middot; Referred ${referral.createdAt.slice(0, 10)}</p>
          </div>
          <div class="flex items-center gap-2">
            <button onclick="openVacancyDetailsModal(${referral.vacancy.id})" class="btn-outline text-xs font-semibold px-4 py-2 rounded-lg">View Job Details</button>
            <button onclick="applyToJob(${referral.vacancy.id}, false, true)" class="btn-primary text-xs font-semibold px-4 py-2 rounded-lg">Apply</button>
            <button onclick="cancelStaffReferralAction(${referral.id})" class="text-xs font-semibold px-4 py-2 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Cancel</button>
          </div>
        </div>`).join("") : `<p class="text-sm" style="color:var(--color-muted)">You have no staff referrals yet.</p>`}</div>
    `;
  }
  if (tab === "notifications") {
    if (currentNotifications().some((n) => !n.read)) {
      api.markAllNotificationsRead().catch(() => {});
    }
    currentNotifications().forEach((n) => (n.read = true));
    content.innerHTML = notificationsTabHtml("Updates about your applications and referrals.");
  }
}

function appRow(app: Application): string {
  const job = vacancies.find((v) => v.id === app.vacancyId);
  if (!job) return "";
  const meta = STATUS_META[app.status] || STATUS_META.pending;
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-start justify-between mb-2 gap-3">
        <div>
          <h4 class="font-semibold text-sm">${job.title}</h4>
          <p class="text-xs" style="color:var(--color-muted)">${job.employer}</p>
        </div>
        <span class="status-pill ${meta.pill} flex-shrink-0">${meta.label}</span>
      </div>
      <div class="flex items-center gap-1.5 mt-3 flex-wrap">
        ${app.history
          .map(
            (h, i) => `
          <span class="text-[10px] px-2 py-1 rounded-full" style="background:var(--color-bg); color:var(--color-muted)">${h.label}</span>
          ${i < app.history.length - 1 ? '<span style="color:var(--color-border)">&rarr;</span>' : ""}
        `,
          )
          .join("")}
      </div>
      <button onclick="openVacancyDetailsModal(${job.id})" class="btn-outline text-xs font-semibold px-3 py-1.5 rounded-lg mt-3">View Job Details</button>
    </div>`;
}

/** Reads the profile form fields into currentUser, saves them to the backend, and clears
 * the dirty flag. Split out from saveProfile() so the unsaved-changes modal can persist
 * the form without forcing a re-render of the profile tab (the pending navigation handles that). */
async function persistProfileForm(): Promise<boolean> {
  if (!currentUser) return false;
  const u: AuthUser = { ...currentUser };
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? "";

  u.surname = $<HTMLInputElement>("pSurname").value;
  u.firstName = $<HTMLInputElement>("pFirstName").value;
  u.middleName = $<HTMLInputElement>("pMiddleName").value;
  u.suffix = val("pSuffix");
  u.dateOfBirth = $<HTMLInputElement>("pDob").value;
  u.sex = $<HTMLSelectElement>("pSex").value;
  u.religion = val("pReligion");
  u.civilStatus = $<HTMLSelectElement>("pCivilStatus").value;
  u.tin = val("pTin");
  u.houseStreet = $<HTMLInputElement>("pHouseStreet").value;
  u.barangay = $<HTMLInputElement>("pBarangay").value;
  u.heightFt = val("pHeight");
  u.contactNumber = $<HTMLInputElement>("pContact").value;
  u.email = $<HTMLInputElement>("pEmail").value;
  u.disabilityTypes = Array.from(document.querySelectorAll<HTMLInputElement>(".pDisability:checked")).map((el) => el.value);
  u.disabilityOthers = val("pDisabilityOthers");

  u.employmentStatus = $<HTMLSelectElement>("pEmploymentStatus").value;
  u.employmentSubType = val("pEmploymentSubType");
  u.employmentSubTypeOthers = val("pEmploymentSubTypeOthers");
  u.monthsLookingForWork = val("pMonthsLooking");
  u.jobSeekerCategory = Array.from(document.querySelectorAll<HTMLInputElement>(".pJobSeekerCategory:checked")).map((el) => el.value);
  u.terminatedAbroadCountry = val("pTerminatedAbroadCountry");
  u.jobSeekerCategoryOthers = val("pJobSeekerCategoryOthers");
  u.isOFW = $<HTMLSelectElement>("pOFW").value;
  u.ofwCountry = val("pOfwCountry");
  u.ofwReturnDate = val("pOfwReturnDate");
  u.is4Ps = $<HTMLSelectElement>("p4Ps").value;
  u.householdIdNo = val("pHouseholdId");

  u.preferredOccupation1 = $<HTMLInputElement>("pOcc1").value;
  u.preferredOccupation2 = $<HTMLInputElement>("pOcc2").value;
  u.workType = $<HTMLSelectElement>("pWorkType").value;
  u.workLocation = $<HTMLSelectElement>("pWorkLocation").value;
  u.preferredLocalAreas = [val("pLocal1"), val("pLocal2"), val("pLocal3")].filter((v) => v.trim() !== "");
  u.preferredOverseasCountries = [val("pOverseas1"), val("pOverseas2"), val("pOverseas3")].filter((v) => v.trim() !== "");
  const languageProficiency: Record<string, string[]> = {};
  for (const lang of LANGUAGES) {
    const skills = Array.from(document.querySelectorAll<HTMLInputElement>(`.pLang[data-lang="${lang}"]:checked`)).map((el) => el.dataset.skill!);
    if (skills.length > 0) languageProficiency[lang] = skills;
  }
  const othersLangName = val("pLangOthersName").trim();
  if (othersLangName) {
    const skills = Array.from(document.querySelectorAll<HTMLInputElement>(".pLangOthers:checked")).map((el) => el.dataset.skill!);
    if (skills.length > 0) languageProficiency[othersLangName] = skills;
  }
  u.languageProficiency = languageProficiency;

  u.currentlyInSchool = $<HTMLSelectElement>("pInSchool").value;
  u.educationLevel = $<HTMLSelectElement>("pEdLevel").value as AuthUser["educationLevel"];
  u.course = $<HTMLInputElement>("pCourse").value;
  u.yearGraduated = $<HTMLInputElement>("pYearGrad").value;
  u.undergradLevelReached = val("pUndergradLevel");
  u.undergradYearLastAttended = val("pUndergradYear");

  u.technicalTraining = $<HTMLInputElement>("pTraining").value;
  u.trainings = [0, 1]
    .map((i) => ({
      course: val(`pTrainCourse${i + 1}`),
      institution: val(`pTrainInstitution${i + 1}`),
      hours: val(`pTrainHours${i + 1}`),
      skillsAcquired: val(`pTrainSkills${i + 1}`),
      certificates: val(`pTrainCerts${i + 1}`),
    }))
    .filter((t) => Object.values(t).some((v) => v.trim() !== ""));
  u.eligibilities = [0, 1, 2]
    .map((i) => ({ name: val(`pElig${i + 1}Name`), dateTaken: val(`pElig${i + 1}Date`) }))
    .filter((e) => e.name.trim() !== "" || e.dateTaken.trim() !== "");
  u.licenses = [0, 1]
    .map((i) => ({ name: val(`pLicense${i + 1}Name`), validUntil: val(`pLicense${i + 1}Valid`) }))
    .filter((l) => l.name.trim() !== "" || l.validUntil.trim() !== "");

  u.otherSkills = Array.from(document.querySelectorAll<HTMLInputElement>(".pOtherSkill:checked")).map((el) => el.value);
  u.otherSkillsCustom = val("pOtherSkillsCustom");
  u.skills = $<HTMLTextAreaElement>("pSkills").value;

  u.companyName = $<HTMLInputElement>("pCompany").value;
  u.position = $<HTMLInputElement>("pPosition").value;
  u.experience = $<HTMLTextAreaElement>("pExperience").value;
  u.workExperiences = [0, 1]
    .map((i) => ({
      companyName: val(`pWork${i + 1}Company`),
      address: val(`pWork${i + 1}Address`),
      position: val(`pWork${i + 1}Position`),
      status: val(`pWork${i + 1}Status`),
      dateFrom: val(`pWork${i + 1}From`),
      dateTo: val(`pWork${i + 1}To`),
    }))
    .filter((w) => Object.values(w).some((v) => v.trim() !== ""));

  u.noDocumentsDeclared = $<HTMLInputElement>("pNoDocuments").checked ? "Yes" : "";

  u.referredTo = Array.from(document.querySelectorAll<HTMLInputElement>(".pReferredTo:checked")).map((el) => el.value);
  u.referredToOthers = val("pReferredToOthers");
  u.applicationType = val("pAppType") || "New Applicant";

  u.name = `${u.firstName} ${u.surname}`.trim() || u.name;
  try {
    // The account's login email can't be changed from here — the server ignores that
    // field on this endpoint — so whatever comes back reflects the real login email.
    currentUser = await api.updateProfile(u);
    profileDirty = false;
    return true;
  } catch (err) {
    showToast(errMsg(err, "Could not save your profile."));
    return false;
  }
}

async function saveProfile() {
  if (!currentUser) return;
  if (!(await persistProfileForm())) return;
  const complete = isProfileComplete(currentUser);
  showToast(complete ? "Profile saved! You're now eligible to apply for jobs." : "Profile saved. Some required fields are still missing; moving to the first one.");
  dashTabInner("profile");
  if (!complete) {
    const fieldIds: Partial<Record<keyof AuthUser, string>> = {
      surname: "pSurname", firstName: "pFirstName", middleName: "pMiddleName", suffix: "pSuffix",
      dateOfBirth: "pDob", sex: "pSex", religion: "pReligion", civilStatus: "pCivilStatus",
      tin: "pTin", houseStreet: "pHouseStreet", barangay: "pBarangay", heightFt: "pHeight",
      contactNumber: "pContact", email: "pEmail", disabilityOthers: "pDisabilityOthers",
      employmentSubTypeOthers: "pEmploymentSubTypeOthers", monthsLookingForWork: "pMonthsLooking",
      terminatedAbroadCountry: "pTerminatedAbroadCountry", jobSeekerCategoryOthers: "pJobSeekerCategoryOthers",
      ofwCountry: "pOfwCountry", ofwReturnDate: "pOfwReturnDate", householdIdNo: "pHouseholdId",
      preferredOccupation1: "pOcc1", preferredOccupation2: "pOcc2", preferredLocalAreas: "pLocal1",
      preferredOverseasCountries: "pOverseas1", educationLevel: "pEdLevel", course: "pCourse",
      yearGraduated: "pYearGrad", undergradLevelReached: "pUndergradLevel",
      undergradYearLastAttended: "pUndergradYear", technicalTraining: "pTraining",
      otherSkillsCustom: "pOtherSkillsCustom", skills: "pSkills", companyName: "pCompany",
      position: "pPosition", experience: "pExperience",
    };
    const missingField = PROFILE_REQUIRED_FIELDS.find((key) => !currentUser?.[key] || String(currentUser[key]).trim() === "");
    const target = missingField ? fieldIds[missingField] : !documentsRequirementMet() ? "pNoDocuments" : undefined;
    if (target) scrollToProfileField(target);
  }
}

/* ================= DOCUMENT UPLOAD (uploaded straight to the backend) ================= */
function docListHtml(): string {
  const docs = currentDocuments();
  if (!docs.length) return "";
  return docs
    .map(
      (doc) => `
    <div class="flex items-center justify-between gap-2 text-xs rounded-lg px-3 py-2 fade-in" style="background:var(--color-bg)">
      <span class="truncate flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" class="flex-shrink-0"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
        <span class="truncate">${doc.name}</span>
      </span>
      <button type="button" onclick="removeDoc(${doc.id})" class="flex-shrink-0 font-semibold" style="color:var(--color-accent-dark)">Remove</button>
    </div>`,
    )
    .join("");
}

async function handleDocUpload(files: FileList | null) {
  if (!files || !files.length || !currentUser) return;
  const list = Array.from(files);
  try {
    for (const f of list) {
      const doc = await api.uploadDocument(f);
      documents.push(doc);
    }
    $("pDocList").innerHTML = docListHtml();
    showToast(list.length === 1 ? "1 file attached." : `${list.length} files attached.`);
  } catch (err) {
    showToast(errMsg(err, "Could not upload the file."));
    $("pDocList").innerHTML = docListHtml();
  }
}

async function removeDoc(id: number) {
  try {
    await api.deleteDocument(id);
    documents = documents.filter((d) => d.id !== id);
    $("pDocList").innerHTML = docListHtml();
  } catch (err) {
    showToast(errMsg(err, "Could not remove the file."));
  }
}

/* ================= DOCUMENT PREVIEW (Sections 15-17) =================
 * Staff/Admin (and a document's own owner) can open the actual uploaded file rather than
 * just seeing its filename. Images render inline with a zoomable <img>; PDFs render in an
 * <iframe>; anything else (doc/docx, etc.) just gets a "preview not available" note plus
 * a working Download link. */
let currentPreviewUrl: string | null = null;
function closeDocPreview() {
  $("docPreviewOverlay").classList.add("hidden");
  if (currentPreviewUrl) {
    URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = null;
  }
  $("docPreviewBody").innerHTML = "";
}
async function previewDocument(id: number, name: string, mimeType: string) {
  $("docPreviewOverlay").classList.remove("hidden");
  $("docPreviewTitle").textContent = name;
  $("docPreviewBody").innerHTML = `<p class="text-sm p-8" style="color:var(--color-muted)">Loading preview&hellip;</p>`;
  ($("docPreviewDownload") as HTMLAnchorElement).removeAttribute("href");
  try {
    const { blob, mimeType: actualType } = await api.fetchDocumentFile(id);
    const type = actualType || mimeType;
    const url = URL.createObjectURL(blob);
    currentPreviewUrl = url;
    const dl = $("docPreviewDownload") as HTMLAnchorElement;
    dl.href = url;
    dl.download = name;
    if (/^image\//.test(type)) {
      $("docPreviewBody").innerHTML = `<img src="${url}" alt="${name}" style="max-width:100%; max-height:70vh; object-fit:contain" />`;
    } else if (type === "application/pdf") {
      $("docPreviewBody").innerHTML = `<iframe src="${url}" title="${name}" style="width:100%; height:70vh; border:0"></iframe>`;
    } else {
      $("docPreviewBody").innerHTML = `<div class="text-center p-8"><p class="text-sm mb-3" style="color:var(--color-muted)">Preview isn't available for this file type (${type || "unknown"}). Use Download to open it.</p></div>`;
    }
  } catch (err) {
    $("docPreviewBody").innerHTML = `<p class="text-sm p-8" style="color:#C0392B">${errMsg(err, "Could not load this document.")}</p>`;
  }
}

/** Renders a requirement/document row for Staff/Admin/owner views with a real
 * View/Preview action (Section 15) instead of just a filename. */
function documentPreviewRowHtml(doc: DocumentMeta): string {
  return `
    <div class="flex items-center justify-between gap-3 border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
      <span class="truncate flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" class="flex-shrink-0"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
        <span class="truncate">${doc.name}</span>
        <span class="text-xs flex-shrink-0" style="color:var(--color-muted)">${doc.uploadedAt.slice(0, 10)}</span>
      </span>
      <button type="button" onclick="previewDocument(${doc.id}, '${doc.name.replace(/'/g, "\\'")}', '${doc.mimeType}')" class="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border); color:var(--color-primary)">View / Preview</button>
    </div>`;
}

/** Save the form together with the document declaration so toggling it cannot discard
 * other profile edits that have not yet been saved. */
async function toggleNoDocuments() {
  if (!currentUser) return;
  if (!(await persistProfileForm())) return;
  dashTabInner("profile");
}

/* ================================================================
 * VERIFICATION STATUS UI — shared by Job Seeker & Employer dashboards
 * ================================================================ */
const VERIFICATION_STATUS_META: Record<string, { label: string; bg: string; fg: string; dot: string }> = {
  draft: { label: "Not Submitted", bg: "#EDEDED", fg: "#555555", dot: "#999999" },
  pending_verification: { label: "Pending Verification", bg: "#FCEFD9", fg: "#8A5A0F", dot: "#C9862A" },
  returned_for_completion: { label: "Returned for Completion", bg: "#FBE3E1", fg: "#9B2C22", dot: "#C0392B" },
  verified: { label: "Verified", bg: "#E4EEDD", fg: "#1F6B3F", dot: "#2E8B57" },
  rejected: { label: "Rejected", bg: "#F3D6D6", fg: "#7A1F1F", dot: "#7A1F1F" },
  suspended: { label: "Suspended", bg: "#E6E6E6", fg: "#3A3A3A", dot: "#3A3A3A" },
};
const VACANCY_STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  draft: { label: "Draft", bg: "#EDEDED", fg: "#555555" },
  pending_approval: { label: "Pending PESO Approval", bg: "#FCEFD9", fg: "#8A5A0F" },
  approved: { label: "Approved — Live", bg: "#E4EEDD", fg: "#1F6B3F" },
  returned_for_completion: { label: "Returned for Changes", bg: "#FBE3E1", fg: "#9B2C22" },
  rejected: { label: "Rejected", bg: "#F3D6D6", fg: "#7A1F1F" },
  expired: { label: "Expired", bg: "#E6E6E6", fg: "#3A3A3A" },
  closed: { label: "Closed", bg: "#DCE3EA", fg: "#33465A" },
};
const EMPLOYER_STATUS_LABELS: Record<string, string> = {
  under_employer_review: "Under Employer Review",
  shortlisted: "Shortlisted",
  interview: "Interview",
  accepted_hired: "Accepted / Hired",
  not_selected: "Not Selected",
};

function verificationStatusDescription(u: AuthUser): string {
  const isEmployer = u.role === "employer";
  switch (u.verificationStatus) {
    case "draft":
      return isEmployer
        ? "Complete your Establishment Profile and submit it for PESO verification before you can post job vacancies."
        : "Complete your Jobseeker Profile and submit it for PESO verification before you can view matched jobs and apply.";
    case "pending_verification":
      return "Your profile is currently being reviewed by PESO Staff. Please wait for verification.";
    case "suspended":
      return `Your establishment account has been suspended by PESO Staff.${u.employerSuspensionReason ? ` Reason: ${u.employerSuspensionReason}` : ""} You cannot post new vacancies while suspended.`;
    case "returned_for_completion":
      return `Staff Remarks: ${u.verificationRemarks || "Please review and complete the missing information."}`;
    case "verified":
      return isEmployer
        ? "Your employer profile has been verified. You can now post job vacancies for PESO approval."
        : "Your profile has been verified. Job matching and applications are now available.";
    case "rejected":
      return `Your profile was not approved by PESO Staff.${u.verificationRemarks ? ` Remarks: ${u.verificationRemarks}` : ""}`;
    default:
      return "";
  }
}

function verificationStatusCardHtml(u: AuthUser): string {
  const meta = VERIFICATION_STATUS_META[u.verificationStatus] || VERIFICATION_STATUS_META.draft;
  return `
    <div class="card rounded-xl p-5 mb-6">
      <p class="text-[11px] font-semibold uppercase tracking-wide mb-2" style="color:var(--color-muted)">Profile Verification</p>
      <div class="flex items-center gap-2 mb-2">
        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${meta.dot}"></span>
        <span class="text-sm font-semibold px-2.5 py-1 rounded-full" style="background:${meta.bg}; color:${meta.fg}">${meta.label}</span>
      </div>
      <p class="text-sm" style="color:var(--color-muted)">${verificationStatusDescription(u)}</p>
      ${u.verificationStatus === "draft" ? registrationExpiryTimerHtml(u.registrationExpiresAt) : ""}
      ${
        u.role === "job_seeker" && (u.verificationStatus === "draft" || u.verificationStatus === "returned_for_completion")
          ? `<button onclick="dashTab('profile')" class="btn-primary text-xs font-semibold px-4 py-2 rounded-lg mt-3">Go to My Profile &rarr;</button>`
          : ""
      }
      ${
        u.role === "employer" && (u.verificationStatus === "draft" || u.verificationStatus === "returned_for_completion")
          ? `<button onclick="dashTab('profile')" class="btn-primary text-xs font-semibold px-4 py-2 rounded-lg mt-3">Go to Establishment Profile &rarr;</button>`
          : ""
      }
    </div>`;
}

function historyTimelineHtml(history: VerificationHistoryEntry[]): string {
  if (!history.length) return `<div class="card rounded-xl p-5 text-xs" style="color:var(--color-muted)">No verification history yet.</div>`;
  return `
    <div class="card rounded-xl overflow-hidden">
      <table class="w-full text-xs">
        <thead><tr style="background:var(--color-bg)">
          <th class="text-left px-3 py-2.5 font-semibold">Date</th>
          <th class="text-left px-3 py-2.5 font-semibold">Action</th>
          <th class="text-left px-3 py-2.5 font-semibold">Status</th>
          <th class="text-left px-3 py-2.5 font-semibold">By</th>
          <th class="text-left px-3 py-2.5 font-semibold">Remarks</th>
        </tr></thead>
        <tbody>
          ${history
            .slice()
            .reverse()
            .map(
              (h) => `
            <tr style="border-top:1px solid var(--color-border)">
              <td class="px-3 py-2.5 whitespace-nowrap">${h.createdAt.slice(0, 10)}</td>
              <td class="px-3 py-2.5 capitalize">${h.action.replace(/_/g, " ")}</td>
              <td class="px-3 py-2.5">${VERIFICATION_STATUS_META[h.newStatus]?.label ?? h.newStatus}</td>
              <td class="px-3 py-2.5">${h.performedBy || "&mdash;"}</td>
              <td class="px-3 py-2.5">${h.remarks || "&mdash;"}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

/** Read-only view shown instead of the editable NSRP form once a Job Seeker's profile
 * is Pending Verification, Verified, or Rejected (Rule 2 / Rule 7). */
function lockedProfileStatusHtml(u: AuthUser): string {
  return `
    <h1 class="font-display text-2xl font-semibold mb-1">Jobseeker Profile</h1>
    <p class="text-sm mb-4" style="color:var(--color-muted)">${
      u.verificationStatus === "pending_verification"
        ? "You cannot edit or resubmit your profile while it is under verification."
        : "Your submitted profile is shown below for reference."
    }</p>
    ${verificationStatusCardHtml(u)}
    <div class="card rounded-xl p-6 mb-6">
      <h3 class="font-semibold text-sm mb-3">Submitted Information (Summary)</h3>
      <div class="grid sm:grid-cols-2 gap-3 text-sm">
        <div><span style="color:var(--color-muted)">Name:</span> ${u.firstName} ${u.middleName} ${u.surname} ${u.suffix}</div>
        <div><span style="color:var(--color-muted)">Contact:</span> ${u.contactNumber}</div>
        <div><span style="color:var(--color-muted)">Address:</span> ${u.houseStreet}, ${u.barangay}, ${u.municipality}</div>
        <div><span style="color:var(--color-muted)">Preferred Occupation:</span> ${u.preferredOccupation1}</div>
        <div><span style="color:var(--color-muted)">Education:</span> ${u.educationLevel} &mdash; ${u.course}</div>
        <div><span style="color:var(--color-muted)">Skills:</span> ${u.skills}</div>
      </div>
    </div>
    <h3 class="font-semibold text-sm mb-3">Verification History</h3>
    ${historyTimelineHtml(myVerificationHistory)}
  `;
}

async function doSubmitProfileForVerification() {
  if (!currentUser) return;
  try {
    currentUser = await api.submitProfileForVerification();
    try {
      myVerificationHistory = await api.getProfileHistory();
    } catch {}
    showToast("Your profile has been submitted successfully and is now waiting for verification by PESO Staff.");
    dashTabInner("profile");
  } catch (err) {
    showToast(errMsg(err, "Could not submit your profile."));
  }
}

/* ================================================================
 * EMPLOYER DASHBOARD
 * ================================================================ */
let employerVacancies: Vacancy[] = [];
let employerApplicants: (Application & { seekerName: string; seekerContact: string; seekerSkills: string; seekerEducation: string; seekerCourse: string; seekerExperience: string; vacancyTitle: string })[] = [];
let showVacancyForm = false;
let editingVacancyId: number | null = null;

const EMPLOYER_TYPE_CATEGORIES: Record<string, string[]> = {
  Public: ["National Government Agency", "Local Government Unit", "Government-Owned and Controlled Corporation", "State/Local University or College", "Other Government Agency"],
  Private: ["Direct Hire", "Local Recruitment Agency", "Overseas Recruitment Agency", "Other Private Employer Type"],
};
const NATURE_OF_WORK_OPTIONS = ["Permanent", "Contractual", "Project-Based", "Internship/OJT", "Work-from-home/Online Job", "Other"];
const WORKFORCE_SIZE_OPTIONS = ["Micro (1-9)", "Small (10-99)", "Medium (100-199)", "Large (200 and up)"];
const PWD_TYPE_OPTIONS = ["Visual", "Hearing", "Speech", "Physical", "Mental", "Other"];

function isEmployerProfileCompleteClient(u: AuthUser): boolean {
  return (["employerBusinessName", "employerTin", "employerType", "employerIndustry", "employerStreet", "employerBarangay", "employerMunicipality", "employerProvince", "employerOwnerName", "employerContactPerson", "employerPosition", "employerMobile", "employerEmail"] as const).every(
    (k) => u[k] && String(u[k]).trim() !== "",
  );
}

async function saveEmployerProfile() {
  if (!currentUser) return;
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? "";
  const payload: Partial<AuthUser> = {
    employerBusinessName: val("epBusinessName"), employerTradeName: val("epTradeName"),
    employerAcronym: val("epAcronym"), employerTin: val("epTin"),
    employerType: val("epType") as any, employerCategory: val("epCategory"),
    employerNatureOfWork: val("epNatureOfWork"), employerWorkforceSize: val("epWorkforceSize"),
    employerIndustry: val("epIndustry"),
    employerStreet: val("epStreet"), employerBarangay: val("epBarangay"),
    employerMunicipality: val("epMunicipality"), employerProvince: val("epProvince"),
    employerOwnerName: val("epOwnerName"), employerContactPerson: val("epContactPerson"),
    employerPosition: val("epPosition"), employerTelephone: val("epTelephone"),
    employerMobile: val("epMobile"), employerFax: val("epFax"), employerEmail: val("epEmail"),
    employerDescription: val("epDescription"),
  };
  try {
    currentUser = await api.updateEmployerProfile(payload);
    const complete = isEmployerProfileCompleteClient(currentUser);
    showToast(
      currentUser.verificationStatus === "pending_verification"
        ? "Establishment profile saved. Sensitive information changed — resubmitted for PESO re-verification."
        : complete
          ? "Establishment profile saved."
          : "Establishment profile saved. Moving to the first missing required field.",
    );
    dashTabInner("profile");
    if (!complete) {
      const fieldIds: Partial<Record<keyof AuthUser, string>> = {
        employerBusinessName: "epBusinessName",
        employerTin: "epTin",
        employerType: "epType",
        employerIndustry: "epIndustry",
        employerStreet: "epStreet",
        employerBarangay: "epBarangay",
        employerMunicipality: "epMunicipality",
        employerProvince: "epProvince",
        employerOwnerName: "epOwnerName",
        employerContactPerson: "epContactPerson",
        employerPosition: "epPosition",
        employerMobile: "epMobile",
        employerEmail: "epEmail",
      };
      const requiredFields = [
        "employerBusinessName", "employerTin", "employerType", "employerIndustry",
        "employerStreet", "employerBarangay", "employerMunicipality", "employerProvince",
        "employerOwnerName", "employerContactPerson", "employerPosition", "employerMobile", "employerEmail",
      ] as const;
      const missingField = requiredFields.find((key) => !currentUser?.[key] || String(currentUser[key]).trim() === "");
      const target = missingField ? fieldIds[missingField] : undefined;
      if (target) scrollToProfileField(target);
    }
  } catch (err) {
    showToast(errMsg(err, "Could not save your establishment profile."));
  }
}

async function doSubmitEmployerProfileForVerification() {
  if (!currentUser) return;
  try {
    currentUser = await api.submitEmployerProfileForVerification();
    try {
      myVerificationHistory = (await api.getEmployerProfile()).history;
    } catch {}
    showToast("Your establishment information has been submitted successfully and is now waiting for verification by PESO Staff.");
    dashTabInner("profile");
  } catch (err) {
    showToast(errMsg(err, "Could not submit your establishment profile."));
  }
}

function toggleNewVacancyForm() {
  showVacancyForm = !showVacancyForm;
  editingVacancyId = null;
  dashTabInner("vacancies");
}
function openNewVacancyForm() {
  showVacancyForm = true;
  editingVacancyId = null;
  dashTabInner("vacancies");
}
function editVacancy(id: number) {
  editingVacancyId = id;
  showVacancyForm = true;
  dashTabInner("vacancies");
}
function cancelVacancyForm() {
  showVacancyForm = false;
  editingVacancyId = null;
  dashTabInner("vacancies");
}

const GINGOOG_MAP_CENTER: L.LatLngTuple = [8.8227, 125.0975];
const mountedMaps = new Map<string, L.Map>();
const mountedMapMarkerSetters = new Map<string, (point: L.LatLng) => void>();
const mountedMapMarkerClearers = new Map<string, () => void>();
type GoogleVacancyMap = { map: google.maps.Map; marker: google.maps.Marker | null; Marker: typeof google.maps.Marker };
const googleVacancyMaps = new Map<string, GoogleVacancyMap>();
const googleLocationMaps = new Map<string, GoogleVacancyMap>();
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? "";
let googleMapsApiPromise: Promise<void> | null = null;
let googleMapConstructor: typeof google.maps.Map | null = null;
let googleMarkerConstructor: typeof google.maps.Marker | null = null;
type GeocodedLocation = { label: string; latitude: number; longitude: number };
let vacancyLocationResults: GeocodedLocation[] = [];
const locationSearchCache = new Map<string, GeocodedLocation[]>();
let vacancyLocationReverseRequest = 0;

function validMapCoordinates(latitude: number | null | undefined, longitude: number | null | undefined): L.LatLngTuple | null {
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return [latitude, longitude];
}

function loadGoogleMapsApi(): Promise<void> {
  if (googleMapConstructor && googleMarkerConstructor) return Promise.resolve();
  if (typeof google !== "undefined" && google.maps
    && typeof google.maps.Map === "function" && typeof google.maps.Marker === "function") {
    googleMapConstructor = google.maps.Map;
    googleMarkerConstructor = google.maps.Marker;
    return Promise.resolve();
  }
  if (!GOOGLE_MAPS_API_KEY) {
    return Promise.reject(new Error("Google Maps API key is missing. Add VITE_GOOGLE_MAPS_API_KEY to frontend/.env to enable Google Maps."));
  }
  if (!googleMapsApiPromise) {
    googleMapsApiPromise = new Promise((resolve, reject) => {
      const importLibraries = async () => {
        try {
          if (typeof google === "undefined" || !google.maps?.importLibrary) {
            if (typeof google !== "undefined" && google.maps
              && typeof google.maps.Map === "function" && typeof google.maps.Marker === "function") {
              googleMapConstructor = google.maps.Map;
              googleMarkerConstructor = google.maps.Marker;
              resolve();
              return;
            }
            throw new Error("Google Maps loaded without its map and marker libraries. Check that the Maps JavaScript API is enabled for this key.");
          }
          const mapsLibrary = await google.maps.importLibrary("maps") as google.maps.MapsLibrary;
          const markerLibrary = await google.maps.importLibrary("marker") as google.maps.MarkerLibrary;
          googleMapConstructor = mapsLibrary.Map;
          googleMarkerConstructor = markerLibrary.Marker;
          resolve();
        } catch (error) {
          googleMapsApiPromise = null;
          reject(error);
        }
      };

      if (typeof google !== "undefined" && google.maps) {
        void importLibraries();
        return;
      }

      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&v=weekly&libraries=maps,marker`;
      script.async = true;
      script.onerror = () => {
        googleMapsApiPromise = null;
        reject(new Error("Google Maps could not load. Check the API key, enabled Maps JavaScript API, billing, and network connection."));
      };
      script.onload = () => void importLibraries();
      document.head.appendChild(script);
    });
  }
  return googleMapsApiPromise;
}

function setVacancyMapMarker(point: L.LatLng): void {
  const googleMap = googleVacancyMaps.get("vfLocationMap");
  if (googleMap) {
    if (googleMap.marker) googleMap.marker.setPosition({ lat: point.lat, lng: point.lng });
    else {
      googleMap.marker = new googleMap.Marker({ map: googleMap.map, position: { lat: point.lat, lng: point.lng }, draggable: true, title: "Job location" });
      googleMap.marker.addListener("dragend", () => {
        const position = googleMap.marker?.getPosition();
        if (position) void updateVacancyLocationFromMap(L.latLng(position.lat(), position.lng()));
      });
    }
    return;
  }
  mountedMapMarkerSetters.get("vfLocationMap")?.(point);
}

function panVacancyMap(point: L.LatLng, zoom?: number): void {
  const googleMap = googleVacancyMaps.get("vfLocationMap");
  if (googleMap) {
    googleMap.map.panTo({ lat: point.lat, lng: point.lng });
    if (zoom !== undefined) googleMap.map.setZoom(zoom);
  } else {
    mountedMaps.get("vfLocationMap")?.setView(point, zoom);
  }
}

async function mountVacancyGoogleMap(coordinates: L.LatLngTuple | null): Promise<void> {
  const element = document.getElementById("vfLocationMap");
  if (!element) return;
  try {
    await loadGoogleMapsApi();
  } catch (error) {
    if (!element.isConnected) return;
    const status = document.getElementById("vfMapSetupStatus");
    if (status) status.textContent = `${errMsg(error, "Google Maps could not load.")} The existing interactive map remains available.`;
    mountLocationMap("vfLocationMap", coordinates, (point) => void updateVacancyLocationFromMap(point));
    return;
  }
  if (!element.isConnected) return;

  mountedMaps.get("vfLocationMap")?.remove();
  mountedMaps.delete("vfLocationMap");
  mountedMapMarkerSetters.delete("vfLocationMap");
  mountedMapMarkerClearers.delete("vfLocationMap");
  const center = coordinates ? { lat: coordinates[0], lng: coordinates[1] } : { lat: GINGOOG_MAP_CENTER[0], lng: GINGOOG_MAP_CENTER[1] };
  const MapConstructor = googleMapConstructor;
  const MarkerConstructor = googleMarkerConstructor;
  if (!MapConstructor || !MarkerConstructor) throw new Error("Google Maps libraries were not initialized.");
  const map = new MapConstructor(element, {
    center,
    zoom: coordinates ? 16 : 13,
    mapTypeControl: true,
    streetViewControl: false,
    fullscreenControl: true,
    clickableIcons: false,
  });
  const state: GoogleVacancyMap = { map, marker: null, Marker: MarkerConstructor };
  googleVacancyMaps.set("vfLocationMap", state);
  if (coordinates) setVacancyMapMarker(L.latLng(coordinates[0], coordinates[1]));
  map.addListener("click", (event: google.maps.MapMouseEvent) => {
    if (!event.latLng) return;
    const point = L.latLng(event.latLng.lat(), event.latLng.lng());
    setVacancyMapMarker(point);
    void updateVacancyLocationFromMap(point);
  });
}

window.addEventListener("resize", () => {
  requestAnimationFrame(() => mountedMaps.forEach((map) => map.invalidateSize({ pan: false })));
}, { passive: true });

function mountLocationMap(
  elementId: string,
  coordinates: L.LatLngTuple | null,
  onPick?: (point: L.LatLng) => void,
) {
  if (onPick) {
    mountLeafletLocationMap(elementId, coordinates, onPick);
    return;
  }
  void mountGoogleLocationMap(elementId, coordinates).catch(() => {
    if (document.getElementById(elementId)?.isConnected) mountLeafletLocationMap(elementId, coordinates);
  });
}

async function mountGoogleLocationMap(elementId: string, coordinates: L.LatLngTuple | null): Promise<void> {
  const element = document.getElementById(elementId);
  if (!element) return;
  await loadGoogleMapsApi();
  if (!element.isConnected) return;
  mountedMaps.get(elementId)?.remove();
  mountedMaps.delete(elementId);
  mountedMapMarkerSetters.delete(elementId);
  mountedMapMarkerClearers.delete(elementId);
  googleLocationMaps.get(elementId)?.marker?.setMap(null);
  googleLocationMaps.delete(elementId);
  const center = coordinates ? { lat: coordinates[0], lng: coordinates[1] } : { lat: GINGOOG_MAP_CENTER[0], lng: GINGOOG_MAP_CENTER[1] };
  const MapConstructor = googleMapConstructor;
  const MarkerConstructor = googleMarkerConstructor;
  if (!MapConstructor || !MarkerConstructor) throw new Error("Google Maps libraries were not initialized.");
  const map = new MapConstructor(element, {
    center,
    zoom: coordinates ? 16 : 13,
    mapTypeControl: true,
    streetViewControl: false,
    fullscreenControl: true,
    clickableIcons: false,
  });
  const marker = coordinates ? new MarkerConstructor({ map, position: center, title: "Job location" }) : null;
  googleLocationMaps.set(elementId, { map, marker, Marker: MarkerConstructor });
}

function mountLeafletLocationMap(
  elementId: string,
  coordinates: L.LatLngTuple | null,
  onPick?: (point: L.LatLng) => void,
) {
  const element = document.getElementById(elementId);
  if (!element) return;
  mountedMaps.get(elementId)?.remove();
  mountedMapMarkerSetters.delete(elementId);
  mountedMapMarkerClearers.delete(elementId);

  const map = L.map(element, { scrollWheelZoom: false }).setView(coordinates ?? GINGOOG_MAP_CENTER, coordinates ? 15 : 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
  }).addTo(map);

  let marker: L.Marker | null = null;
  const setMarker = (point: L.LatLng) => {
    if (marker) marker.setLatLng(point);
    else {
      marker = L.marker(point, { draggable: Boolean(onPick), title: "Job location" }).addTo(map);
      marker.bindPopup(`Location: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`);
      if (onPick) marker.on("dragend", () => onPick(marker!.getLatLng()));
    }
    marker.setPopupContent(`Location: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`);
  };
  if (coordinates) setMarker(L.latLng(coordinates[0], coordinates[1]));
  if (onPick) {
    map.on("click", (event: L.LeafletMouseEvent) => {
      setMarker(event.latlng);
      onPick(event.latlng);
    });
  }

  mountedMaps.set(elementId, map);
  mountedMapMarkerSetters.set(elementId, setMarker);
  mountedMapMarkerClearers.set(elementId, () => {
    marker?.remove();
    marker = null;
  });
  requestAnimationFrame(() => map.invalidateSize());
}

function updateVacancyLocationPin(point: L.LatLng, confirmed = false) {
  const latitudeInput = document.getElementById("vfLatitude") as HTMLInputElement | null;
  const longitudeInput = document.getElementById("vfLongitude") as HTMLInputElement | null;
  const selectedLocation = document.getElementById("vfSelectedLocation");
  const confirmedInput = document.getElementById("vfLocationConfirmed") as HTMLInputElement | null;
  if (!latitudeInput || !longitudeInput || !selectedLocation || !confirmedInput) return;

  latitudeInput.value = point.lat.toFixed(7);
  longitudeInput.value = point.lng.toFixed(7);
  confirmedInput.value = String(confirmed);
  selectedLocation.textContent = confirmed
    ? `Location confirmed · ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
    : `Pin selected · ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}. Confirm this exact location before submitting.`;
}

async function updateVacancyLocationFromMap(point: L.LatLng) {
  updateVacancyLocationPin(point);
  const requestId = ++vacancyLocationReverseRequest;
  const input = document.getElementById("vfLocation") as HTMLInputElement | null;
  const areaSelectedInput = document.getElementById("vfLocationAreaSelected") as HTMLInputElement | null;
  const resultsSelect = document.getElementById("vfLocationResults") as HTMLSelectElement | null;
  const status = document.getElementById("vfLocationSearchStatus");
  if (!input || !areaSelectedInput || !resultsSelect) return;

  areaSelectedInput.value = "false";
  input.value = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  if (status) status.textContent = "Finding the Gingoog City address for this map pin…";
  try {
    const location = await api.reverseSearchEmployerLocation(point.lat, point.lng);
    if (requestId !== vacancyLocationReverseRequest || !document.getElementById("vfLocation")) return;
    input.value = location.label;
    areaSelectedInput.value = "true";
    vacancyLocationResults = [location];
    resultsSelect.innerHTML = `<option value="0">${escapeReportHtml(location.label)}</option>`;
    resultsSelect.classList.remove("hidden");
    if (status) status.textContent = "Address found. Confirm the exact map pin before submitting.";
  } catch (error) {
    if (requestId !== vacancyLocationReverseRequest) return;
    if (status) status.textContent = errMsg(error, "Could not find an address for this map pin. Try another location.");
  }
}

function mountVacancyLocationPicker(vacancy?: Vacancy) {
  vacancyLocationReverseRequest++;
  const latitudeInput = document.getElementById("vfLatitude") as HTMLInputElement | null;
  const longitudeInput = document.getElementById("vfLongitude") as HTMLInputElement | null;
  const selectedLocation = document.getElementById("vfSelectedLocation");
  const confirmedInput = document.getElementById("vfLocationConfirmed") as HTMLInputElement | null;
  const areaSelectedInput = document.getElementById("vfLocationAreaSelected") as HTMLInputElement | null;
  const locationResults = document.getElementById("vfLocationResults") as HTMLSelectElement | null;
  if (!latitudeInput || !longitudeInput || !selectedLocation || !confirmedInput || !areaSelectedInput || !locationResults) return;

  vacancyLocationResults = [];
  locationResults.innerHTML = `<option value="">Search for and select a Gingoog City area</option>`;
  locationResults.classList.add("hidden");
  const coordinates = validMapCoordinates(vacancy?.latitude, vacancy?.longitude);
  latitudeInput.value = coordinates ? String(coordinates[0]) : "";
  longitudeInput.value = coordinates ? String(coordinates[1]) : "";
  confirmedInput.value = String(Boolean(coordinates));
  areaSelectedInput.value = String(Boolean(coordinates));
  selectedLocation.textContent = coordinates
    ? `Saved pin loaded · ${coordinates[0].toFixed(5)}, ${coordinates[1].toFixed(5)}. Confirm or adjust it before submitting.`
    : "Search for a Gingoog City location, select a result, then place the exact workplace pin.";

  void mountVacancyGoogleMap(coordinates);
}

async function searchVacancyLocations(): Promise<void> {
  vacancyLocationReverseRequest++;
  const input = document.getElementById("vfLocation") as HTMLInputElement | null;
  const resultsSelect = document.getElementById("vfLocationResults") as HTMLSelectElement | null;
  const status = document.getElementById("vfLocationSearchStatus");
  const button = document.getElementById("vfLocationSearchButton") as HTMLButtonElement | null;
  if (!input || !resultsSelect || !status || !button) return;
  const query = input.value.trim();
  if (query.length < 2) {
    status.textContent = "Enter at least two characters to search for a place.";
    return;
  }
  const cacheKey = query.toLocaleLowerCase();
  button.disabled = true;
  status.textContent = "Searching OpenStreetMap…";
  resultsSelect.classList.add("hidden");
  try {
    let found = locationSearchCache.get(cacheKey);
    if (!found) {
      found = await api.searchEmployerLocations(query);
      locationSearchCache.set(cacheKey, found);
    }
    vacancyLocationResults = found;
    if (!found.length) {
      status.textContent = "No matching Gingoog City locations found. Try a barangay, street, or nearby landmark.";
      return;
    }
    resultsSelect.innerHTML = `<option value="">Choose a matched location</option>${found.map((item, index) => `<option value="${index}">${escapeReportHtml(item.label)}</option>`).join("")}`;
    resultsSelect.classList.remove("hidden");
    status.textContent = `${found.length} matching location(s). Select one to center the map.`;
  } catch (error) {
    status.textContent = errMsg(error, "Could not search for locations. Check your connection and try again.");
  } finally {
    button.disabled = false;
  }
}

function selectVacancyLocationResult(): void {
  vacancyLocationReverseRequest++;
  const select = document.getElementById("vfLocationResults") as HTMLSelectElement | null;
  const input = document.getElementById("vfLocation") as HTMLInputElement | null;
  const areaSelected = document.getElementById("vfLocationAreaSelected") as HTMLInputElement | null;
  const selectedIndex = Number(select?.value);
  const result = select?.value && Number.isInteger(selectedIndex) ? vacancyLocationResults[selectedIndex] : null;
  if (!result || !input || !areaSelected) return;

  input.value = result.label;
  areaSelected.value = "true";
  const point = L.latLng(result.latitude, result.longitude);
  panVacancyMap(point, 16);
  setVacancyMapMarker(point);
  updateVacancyLocationPin(point);
  const status = document.getElementById("vfLocationSearchStatus");
  if (status) status.textContent = "Area selected. Adjust the pin to the exact workplace, then confirm the location.";
}

function vacancyLocationTextChanged(): void {
  vacancyLocationReverseRequest++;
  const areaSelected = document.getElementById("vfLocationAreaSelected") as HTMLInputElement | null;
  const confirmedInput = document.getElementById("vfLocationConfirmed") as HTMLInputElement | null;
  const status = document.getElementById("vfLocationSearchStatus");
  if (areaSelected) areaSelected.value = "false";
  if (confirmedInput) confirmedInput.value = "false";
  if (status) status.textContent = "Search and select a matching Gingoog City location again.";
}

function confirmVacancyLocation(): void {
  const latitudeInput = document.getElementById("vfLatitude") as HTMLInputElement | null;
  const longitudeInput = document.getElementById("vfLongitude") as HTMLInputElement | null;
  const areaSelected = document.getElementById("vfLocationAreaSelected") as HTMLInputElement | null;
  const coordinates = validMapCoordinates(Number(latitudeInput?.value), Number(longitudeInput?.value));
  if (!areaSelected || areaSelected.value !== "true" || !coordinates) {
    showToast("Search for and select a Gingoog City area, then place the map pin before confirming.");
    return;
  }
  updateVacancyLocationPin(L.latLng(coordinates[0], coordinates[1]), true);
}

function clearVacancyLocation(): void {
  vacancyLocationReverseRequest++;
  const input = document.getElementById("vfLocation") as HTMLInputElement | null;
  const latitudeInput = document.getElementById("vfLatitude") as HTMLInputElement | null;
  const longitudeInput = document.getElementById("vfLongitude") as HTMLInputElement | null;
  const confirmedInput = document.getElementById("vfLocationConfirmed") as HTMLInputElement | null;
  const areaSelected = document.getElementById("vfLocationAreaSelected") as HTMLInputElement | null;
  const results = document.getElementById("vfLocationResults");
  if (input) input.value = "";
  if (latitudeInput) latitudeInput.value = "";
  if (longitudeInput) longitudeInput.value = "";
  if (confirmedInput) confirmedInput.value = "false";
  if (areaSelected) areaSelected.value = "false";
  results?.classList.add("hidden");
  const googleMap = googleVacancyMaps.get("vfLocationMap");
  googleMap?.marker?.setMap(null);
  if (googleMap) googleMap.marker = null;
  panVacancyMap(L.latLng(GINGOOG_MAP_CENTER[0], GINGOOG_MAP_CENTER[1]), 13);
  mountedMapMarkerClearers.get("vfLocationMap")?.();
  const selectedLocation = document.getElementById("vfSelectedLocation");
  const status = document.getElementById("vfLocationSearchStatus");
  if (selectedLocation) selectedLocation.textContent = "No map pin selected. Search for a location to begin.";
  if (status) status.textContent = "Search for a Gingoog City area to choose a new location.";
}

function vacancyFormHtml(existing?: Vacancy): string {
  const v = existing;
  const levels = ["Elementary", "Secondary", "Senior High", "Tertiary", "Graduate Studies", "Post-graduate"];
  return `
    <div class="card rounded-xl p-6 mb-4 fade-in">
      <h3 class="font-semibold text-sm mb-3">${v ? `Edit Vacancy ${v.status === "draft" ? "(Draft)" : ""}` : "Add Job Vacancy"}</h3>
      ${v && (v.status === "returned_for_completion" || v.status === "rejected") && v.remarks ? `<p class="text-xs mb-3 rounded-lg px-3 py-2" style="background:#FBE3E1; color:#9B2C22"><strong>Staff Remarks:</strong> ${v.remarks}</p>` : ""}
      <h4 class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--color-muted)">Vacancy Details</h4>
      <div class="grid sm:grid-cols-2 gap-3 mb-4">
        <div><label for="vfTitle" class="text-xs font-semibold block mb-1">Position Title *</label><input id="vfTitle" value="${v?.title ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfCategory" class="text-xs font-semibold block mb-1">Category *</label><input id="vfCategory" value="${v?.category ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfType" class="text-xs font-semibold block mb-1">Nature of Work *</label>
          <select id="vfType" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
            ${NATURE_OF_WORK_OPTIONS.map((o) => `<option ${v?.type === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
        <div class="sm:col-span-2">
          <label for="vfLocation" class="text-xs font-semibold block mb-1">Search and select a place of work in Gingoog City *</label>
          <div class="flex flex-col sm:flex-row gap-2">
            <input id="vfLocation" value="${escapeReportHtml(v?.location ?? "")}" onchange="vacancyLocationTextChanged()" placeholder="Search a barangay, street, or landmark" class="w-full min-w-0 border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
            <button type="button" id="vfLocationSearchButton" onclick="searchVacancyLocations()" class="btn-outline text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap">Search map</button>
            <button type="button" onclick="clearVacancyLocation()" class="text-sm font-semibold px-3 py-2 rounded-lg border" style="border-color:var(--color-border)">Clear</button>
          </div>
          <p id="vfLocationSearchStatus" class="text-xs mt-1" style="color:var(--color-muted)">Search results are provided by OpenStreetMap Nominatim.</p>
          <select id="vfLocationResults" onchange="selectVacancyLocationResult()" class="w-full mt-2 border rounded-lg px-3 py-2 text-sm hidden" style="border-color:var(--color-border)" aria-label="Matching Gingoog City locations"></select>
          <input id="vfLocationAreaSelected" type="hidden" value="${v && validMapCoordinates(v.latitude, v.longitude) ? "true" : "false"}">
        </div>
        <div><label for="vfSalary" class="text-xs font-semibold block mb-1">Salary *</label>
          <div class="flex items-stretch">
            <span class="inline-flex items-center px-3 rounded-l-lg border border-r-0 text-sm font-semibold" style="border-color:var(--color-border); background:var(--color-bg); color:var(--color-muted)">&#8369;</span>
            <input id="vfSalary" value="${v?.salary ?? ""}" placeholder="e.g. 12,000 - 15,000" class="w-full border rounded-r-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
          </div>
        </div>
        <div><label for="vfSlots" class="text-xs font-semibold block mb-1">Vacancy Count *</label><input id="vfSlots" type="number" min="1" value="${v?.slots ?? 1}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
      </div>
      <div class="mb-5">
        <label class="text-xs font-semibold block mb-1">Pin the exact job location *</label>
        <p class="text-xs mb-2" style="color:var(--color-muted)">Select an area, then click the map or drag the pin to the exact workplace. Confirm the location before submitting.</p>
        <p id="vfMapSetupStatus" class="text-xs mb-2" style="color:var(--color-muted)" role="status"></p>
        <div id="vfLocationMap" class="location-map-picker rounded-lg border" style="height:360px;border-color:var(--color-border)"></div>
        <p id="vfSelectedLocation" class="text-xs mt-2" style="color:var(--color-muted)"></p>
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" onclick="confirmVacancyLocation()" class="btn-primary text-xs font-semibold px-4 py-2 rounded-lg">Confirm Location</button>
        </div>
        <input id="vfLatitude" type="hidden" value="${v?.latitude ?? ""}">
        <input id="vfLongitude" type="hidden" value="${v?.longitude ?? ""}">
        <input id="vfLocationConfirmed" type="hidden" value="${v && validMapCoordinates(v.latitude, v.longitude) ? "true" : "false"}">
      </div>
      <div class="mb-4"><label for="vfDescription" class="text-xs font-semibold block mb-1">Job Description *</label><textarea id="vfDescription" rows="3" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">${v?.description ?? ""}</textarea></div>

      <h4 class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--color-muted)">Qualification Requirements</h4>
      <div class="grid sm:grid-cols-2 gap-3 mb-3">
        <div><label for="vfWorkExperience" class="text-xs font-semibold block mb-1">Work Experience (months/years)</label><input id="vfWorkExperience" value="${v?.workExperience ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfMinEd" class="text-xs font-semibold block mb-1">Educational Level *</label>
          <select id="vfMinEd" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
            ${levels.map((l) => `<option ${v?.minEducationLevel === l ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div><label for="vfMinExp" class="text-xs font-semibold block mb-1">Minimum Experience (years) *</label><input id="vfMinExp" type="number" min="0" value="${v?.minExperienceYears ?? 0}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfCourseShs" class="text-xs font-semibold block mb-1">Course / SHS Strand</label><input id="vfCourseShs" value="${v?.courseShsStrand ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfLicense" class="text-xs font-semibold block mb-1">License</label><input id="vfLicense" value="${v?.license ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfCertification" class="text-xs font-semibold block mb-1">Certification</label><input id="vfCertification" value="${v?.certification ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfEligibility" class="text-xs font-semibold block mb-1">Eligibility</label><input id="vfEligibility" value="${v?.eligibility ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
        <div><label for="vfLanguage" class="text-xs font-semibold block mb-1">Language/Dialect</label><input id="vfLanguage" value="${v?.languageDialect ?? ""}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
      </div>
      <div class="mb-3"><label for="vfOtherQualifications" class="text-xs font-semibold block mb-1">Other Qualifications</label><textarea id="vfOtherQualifications" rows="2" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">${v?.otherQualifications ?? ""}</textarea></div>
      <div class="mb-3"><label for="vfSkills" class="text-xs font-semibold block mb-1">Required Skills (comma separated, used for job matching)</label><input id="vfSkills" value="${(v?.requiredSkills ?? []).join(", ")}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
      <div class="mb-3"><label for="vfQualification" class="text-xs font-semibold block mb-1">Qualifications List (one per line, shown to Job Seekers)</label><textarea id="vfQualification" rows="2" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">${(v?.qualification ?? []).join("\n")}</textarea></div>

      <div class="grid sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label for="vfAcceptsPwd" class="text-xs font-semibold block mb-1">Accepts Persons with Disabilities (PWD)?</label>
          <select id="vfAcceptsPwd" onchange="document.getElementById('vfPwdTypesWrap').style.display = this.value === 'Yes' ? 'block' : 'none'" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
            <option value="" ${!v?.acceptsPwd ? "selected" : ""}>Not specified</option>
            <option value="Yes" ${v?.acceptsPwd === "Yes" ? "selected" : ""}>Yes</option>
            <option value="No" ${v?.acceptsPwd === "No" ? "selected" : ""}>No</option>
          </select>
          <div id="vfPwdTypesWrap" style="display:${v?.acceptsPwd === "Yes" ? "block" : "none"}" class="mt-2 flex flex-wrap gap-2">
            ${PWD_TYPE_OPTIONS.map((t) => `<label class="text-xs flex items-center gap-1 border rounded-lg px-2 py-1" style="border-color:var(--color-border)"><input type="checkbox" class="vfPwdType" value="${t}" ${(v?.pwdTypes ?? []).includes(t) ? "checked" : ""}> ${t}</label>`).join("")}
          </div>
        </div>
        <div>
          <label for="vfAcceptsOfw" class="text-xs font-semibold block mb-1">Accepts Returning OFWs?</label>
          <select id="vfAcceptsOfw" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
            <option value="" ${!v?.acceptsReturningOfw ? "selected" : ""}>Not specified</option>
            <option value="Yes" ${v?.acceptsReturningOfw === "Yes" ? "selected" : ""}>Yes</option>
            <option value="No" ${v?.acceptsReturningOfw === "No" ? "selected" : ""}>No</option>
          </select>
        </div>
      </div>

      <h4 class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--color-muted)">Posting Details</h4>
      <div class="grid sm:grid-cols-2 gap-3 mb-5">
        <div>
          <label for="vfExpiryDays" class="text-xs font-semibold block mb-1">Vacancy duration *</label>
          <select id="vfExpiryDays" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
            ${[2, 3, 4, 5].map((days) => `<option value="${days}" ${(v?.expiryDays ?? 5) === days ? "selected" : ""}>${days} days</option>`).join("")}
          </select>
          <p class="text-xs mt-1" style="color:var(--color-muted)">The vacancy will be removed from Find Jobs after this period from PESO approval.</p>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button type="button" onclick="submitVacancyForm(${v ? v.id : "null"}, true)" class="text-sm font-semibold px-5 py-2 rounded-lg border" style="border-color:var(--color-border)">Save as Draft</button>
        <button type="button" onclick="submitVacancyForm(${v ? v.id : "null"}, false)" class="btn-primary px-5 py-2 rounded-lg text-sm font-semibold">${v && v.status !== "draft" ? "Resubmit for Approval" : "Submit for Approval"}</button>
        <button type="button" onclick="cancelVacancyForm()" class="px-5 py-2 rounded-lg text-sm font-semibold border" style="border-color:var(--color-border)">Cancel</button>
      </div>
    </div>`;
}

async function submitVacancyForm(id: number | null, saveAsDraft: boolean) {
  const val = (i: string) => (document.getElementById(i) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? "";
  const pwdTypes = Array.from(document.querySelectorAll<HTMLInputElement>(".vfPwdType:checked")).map((el) => el.value);
  const locationConfirmed = val("vfLocationConfirmed") === "true";
  const payload: Partial<Vacancy> & { isDraft?: boolean } = {
    title: val("vfTitle"),
    category: val("vfCategory"),
    location: val("vfLocation"),
    latitude: locationConfirmed && val("vfLatitude") !== "" ? Number(val("vfLatitude")) : null,
    longitude: locationConfirmed && val("vfLongitude") !== "" ? Number(val("vfLongitude")) : null,
    salary: val("vfSalary"),
    type: val("vfType"),
    slots: Number(val("vfSlots")) || 1,
    minEducationLevel: val("vfMinEd") as EducationLevel,
    minExperienceYears: Number(val("vfMinExp")) || 0,
    description: val("vfDescription"),
    qualification: val("vfQualification").split("\n").map((s) => s.trim()).filter(Boolean),
    requiredSkills: val("vfSkills").split(",").map((s) => s.trim()).filter(Boolean),
    workExperience: val("vfWorkExperience"),
    otherQualifications: val("vfOtherQualifications"),
    acceptsPwd: val("vfAcceptsPwd") as "" | "Yes" | "No",
    pwdTypes,
    acceptsReturningOfw: val("vfAcceptsOfw") as "" | "Yes" | "No",
    courseShsStrand: val("vfCourseShs"),
    license: val("vfLicense"),
    certification: val("vfCertification"),
    eligibility: val("vfEligibility"),
    languageDialect: val("vfLanguage"),
    expiryDays: Number(val("vfExpiryDays")),
  };
  if (!payload.title?.trim()) {
    showToast("Position Title is required.");
    return;
  }
  if (!saveAsDraft && (document.getElementById("vfLocationAreaSelected") as HTMLInputElement | null)?.value !== "true") {
    showToast("Please search for and select a Gingoog City area before submitting.");
    return;
  }
  if (!saveAsDraft && !locationConfirmed) {
    showToast("Please select a Gingoog City area and confirm the exact job location before submitting.");
    return;
  }
  if (!saveAsDraft && !validMapCoordinates(payload.latitude, payload.longitude)) {
    showToast("Please set a valid map pin before submitting.");
    return;
  }
  try {
    if (id) {
      await api.updateEmployerVacancy(id, payload);
      if (!saveAsDraft) await api.submitEmployerVacancy(id);
      showToast(saveAsDraft ? "Draft saved." : "Vacancy submitted for PESO approval.");
    } else {
      const created = await api.createEmployerVacancy({ ...payload, isDraft: saveAsDraft });
      if (!saveAsDraft) {
        showToast("Vacancy submitted for PESO approval.");
      } else {
        showToast("Vacancy saved as draft.");
      }
      id = created.id;
    }
    showVacancyForm = false;
    editingVacancyId = null;
    employerVacancies = await api.getEmployerVacancies();
    dashTabInner("vacancies");
  } catch (err) {
    showToast(errMsg(err, "Could not save this vacancy."));
  }
}

async function submitDraftVacancy(id: number) {
  try {
    await api.submitEmployerVacancy(id);
    showToast("Vacancy submitted for PESO approval.");
    employerVacancies = await api.getEmployerVacancies();
    dashTabInner("vacancies");
  } catch (err) {
    showToast(errMsg(err, "Could not submit this vacancy."));
  }
}
async function closeVacancyAction(id: number) {
  if (!window.confirm("Close this vacancy? It will no longer be visible to Job Seekers.")) return;
  try {
    await api.closeEmployerVacancy(id);
    showToast("Vacancy closed.");
    employerVacancies = await api.getEmployerVacancies();
    dashTabInner("vacancies");
  } catch (err) {
    showToast(errMsg(err, "Could not close this vacancy."));
  }
}

function employerVacancyRow(v: Vacancy): string {
  const meta = VACANCY_STATUS_META[v.status] || VACANCY_STATUS_META.pending_approval;
  const appliedCount = employerApplicants.filter((a) => a.vacancyId === v.id).length;
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-start justify-between gap-3 mb-1">
        <h4 class="font-semibold text-sm">${v.title || "(untitled)"}</h4>
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0" style="background:${meta.bg}; color:${meta.fg}">${meta.label}</span>
      </div>
      <p class="text-xs" style="color:var(--color-muted)">${v.category || "&mdash;"} &middot; ${v.location || "&mdash;"} &middot; ${v.slots} slot(s) remaining &middot; ${appliedCount} applicant(s)</p>
      ${v.validUntil ? `<p class="text-xs mt-1" style="color:var(--color-muted)">Valid Until: ${v.validUntil}</p>` : ""}
      ${(v.status === "returned_for_completion" || v.status === "rejected") && v.remarks ? `<p class="text-xs mt-2 rounded-lg px-3 py-2" style="background:#FBE3E1; color:#9B2C22"><strong>Staff Remarks:</strong> ${v.remarks}</p>` : ""}
      <div class="flex flex-wrap gap-2 mt-3">
        ${v.status === "draft" ? `<button onclick="editVacancy(${v.id})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border)">Edit Draft</button>
          <button onclick="submitDraftVacancy(${v.id})" class="btn-primary text-xs font-semibold px-3 py-1.5 rounded-lg">Submit for Approval</button>` : ""}
        ${v.status === "returned_for_completion" || v.status === "rejected" ? `<button onclick="editVacancy(${v.id})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-primary); color:var(--color-primary)">Edit &amp; Resubmit</button>` : ""}
        ${v.status === "approved" || v.status === "expired" ? `<button onclick="closeVacancyAction(${v.id})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border)">Close Vacancy</button>` : ""}
      </div>
    </div>`;
}

function employerApplicantRow(a: Application & { seekerName: string; seekerContact: string; seekerSkills: string; seekerEducation: string; seekerCourse: string; seekerExperience: string; vacancyTitle: string }): string {
  const statusLabel = a.employerStatus ? EMPLOYER_STATUS_LABELS[a.employerStatus] || a.employerStatus : "Awaiting Your Review";
  const isFinal = a.employerStatus === "accepted_hired" || a.employerStatus === "not_selected";
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-start justify-between gap-3 mb-2">
        <div>
          <h4 class="font-semibold text-sm">${a.seekerName} ${a.isStaffReferral ? `<span class="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ml-1" style="background:#DCEAF7; color:#1D5A85">PESO Staff Referral</span>` : ""}</h4>
          <p class="text-xs" style="color:var(--color-muted)">Applied for ${a.vacancyTitle} &middot; Applied ${a.dateApplied}</p>
        </div>
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0" style="background:${a.employerStatus === "accepted_hired" ? "#E4EEDD" : a.employerStatus === "not_selected" ? "#F3D6D6" : "#DCE9F7"}; color:${a.employerStatus === "accepted_hired" ? "#1F6B3F" : a.employerStatus === "not_selected" ? "#7A1F1F" : "#1F4E8C"}">${statusLabel}</span>
      </div>
      <div class="grid sm:grid-cols-2 gap-1 text-xs mb-3" style="color:var(--color-muted)">
        <div>Contact: ${a.seekerContact || "&mdash;"}</div>
        <div>Education: ${a.seekerEducation || "&mdash;"} ${a.seekerCourse ? `(${a.seekerCourse})` : ""}</div>
        <div class="sm:col-span-2">Skills: ${a.seekerSkills || "&mdash;"}</div>
        ${a.seekerExperience ? `<div class="sm:col-span-2">Experience: ${a.seekerExperience}</div>` : ""}
      </div>
      <div class="mb-3">
        <button onclick="openEmployerSeekerProfile(${a.id})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-primary); color:var(--color-primary)">View Profile</button>
      </div>
      ${
        !isFinal
          ? `<div class="flex items-center gap-2">
              <select id="empAppStatus${a.id}" class="border rounded-lg px-3 py-1.5 text-xs" style="border-color:var(--color-border)">
                ${Object.entries(EMPLOYER_STATUS_LABELS).map(([k, label]) => `<option value="${k}" ${k === a.employerStatus ? "selected" : ""}>${label}</option>`).join("")}
              </select>
              <button onclick="updateEmployerApplicationStatusAction(${a.id})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border)">Update Status</button>
            </div>`
          : `<p class="text-xs" style="color:var(--color-muted)">${a.employerRemarks || ""}</p>`
      }
    </div>`;
}

/** Section 4: Admin's read-only view of an Employer's "IX. Application Information"
 * list. Unlike employerApplicantRow, this has no status-change control (that decision
 * belongs to the Employer, not Admin) and its "View Profile" button navigates to the
 * full Admin Seeker Profile page for the exact seeker selected, rather than opening
 * the Employer-only quick-view modal (which Admin isn't authorized to call). */
function adminEmployerApplicantRowHtml(a: Application & { seekerEmail: string; seekerName: string; seekerContact: string; seekerSkills: string; seekerEducation: string; seekerCourse: string; seekerExperience: string; vacancyTitle: string }): string {
  const statusLabel = a.employerStatus ? EMPLOYER_STATUS_LABELS[a.employerStatus] || a.employerStatus : "Awaiting Employer Review";
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-start justify-between gap-3 mb-2">
        <div>
          <h4 class="font-semibold text-sm">${a.seekerName} ${a.isStaffReferral ? `<span class="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ml-1" style="background:#DCEAF7; color:#1D5A85">PESO Staff Referral</span>` : ""}</h4>
          <p class="text-xs" style="color:var(--color-muted)">Applied for ${a.vacancyTitle} &middot; Applied ${a.dateApplied}</p>
        </div>
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0" style="background:${a.employerStatus === "accepted_hired" ? "#E4EEDD" : a.employerStatus === "not_selected" ? "#F3D6D6" : "#DCE9F7"}; color:${a.employerStatus === "accepted_hired" ? "#1F6B3F" : a.employerStatus === "not_selected" ? "#7A1F1F" : "#1F4E8C"}">${statusLabel}</span>
      </div>
      <div class="grid sm:grid-cols-2 gap-1 text-xs mb-3" style="color:var(--color-muted)">
        <div>Contact: ${a.seekerContact || "&mdash;"}</div>
        <div>Education: ${a.seekerEducation || "&mdash;"} ${a.seekerCourse ? `(${a.seekerCourse})` : ""}</div>
        <div class="sm:col-span-2">Skills: ${a.seekerSkills || "&mdash;"}</div>
        ${a.seekerExperience ? `<div class="sm:col-span-2">Experience: ${a.seekerExperience}</div>` : ""}
      </div>
      <button onclick="adminViewApplicantSeekerProfile('${a.seekerEmail}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-primary); color:var(--color-primary)">View Profile</button>
      ${a.employerRemarks ? `<p class="text-xs mt-2" style="color:var(--color-muted)">${a.employerRemarks}</p>` : ""}
    </div>`;
}

async function updateEmployerApplicationStatusAction(id: number) {
  const select = document.getElementById(`empAppStatus${id}`) as HTMLSelectElement | null;
  if (!select) return;
  try {
    await api.updateEmployerApplicationStatus(id, select.value);
    showToast("Application status updated.");
    dashTabInner("applications");
  } catch (err) {
    showToast(errMsg(err, "Could not update this application."));
  }
}

/* ================= EMPLOYER: VIEW SEEKER PROFILE ================= *
 * Lets an Employer review the complete profile of someone who applied to one of
 * their own vacancies — reusing the exact same seeker account data Staff/Admin
 * already see (no duplicate profile is created). Access is scoped server-side to
 * applications for the employer's own vacancies (see GET
 * /api/employer/applications/:id/seeker), and the fields shown here are the
 * hiring-relevant subset of the seeker's profile — the same personal-verification
 * fields (religion, TIN, 4Ps/household ID, disability details) that PESO Staff use
 * for eligibility screening are left to Staff/Admin and are not surfaced to Employers. */
function employerSeekerProfileSectionsHtml(p: AuthUser, documents: DocumentMeta[]): string {
  const langProf = p.languageProficiency || {};
  return `
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">Personal &amp; Contact Information</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Full Name:</span> ${[p.firstName, p.middleName, p.surname, p.suffix].filter(Boolean).join(" ") || p.name || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Email:</span> ${p.email}</div>
        <div><span style="color:var(--color-muted)">Contact Number:</span> ${p.contactNumber || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Address:</span> ${[p.houseStreet, p.barangay, p.municipality, p.province].filter(Boolean).join(", ") || "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">Job Preferences</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Preferred Occupation:</span> ${[p.preferredOccupation1, p.preferredOccupation2].filter(Boolean).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Work Type / Location:</span> ${p.workType || "&mdash;"} / ${p.workLocation || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Employment Status:</span> ${p.employmentStatus || "&mdash;"} ${p.employmentSubType ? `(${p.employmentSubType})` : ""}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">Education</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Education Level:</span> ${p.educationLevel || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Course:</span> ${p.course || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Year Graduated:</span> ${p.yearGraduated || "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">Skills, Trainings, Eligibilities &amp; Licenses</h3>
      <div class="text-sm space-y-2">
        <div><span style="color:var(--color-muted)">Skills:</span> ${p.skills || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Other Skills:</span> ${(p.otherSkills || []).join(", ") || "&mdash;"} ${p.otherSkillsCustom ? `&mdash; ${p.otherSkillsCustom}` : ""}</div>
        <div><span style="color:var(--color-muted)">Technical/Vocational Training:</span> ${p.technicalTraining || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Trainings:</span> ${
          (p.trainings || []).length
            ? `<ul class="list-disc ml-5 mt-1">${p.trainings.map((t) => `<li>${t.course} &mdash; ${t.institution} (${t.hours} hrs)${t.skillsAcquired ? `: ${t.skillsAcquired}` : ""}</li>`).join("")}</ul>`
            : "&mdash;"
        }</div>
        <div><span style="color:var(--color-muted)">Eligibilities:</span> ${(p.eligibilities || []).map((e) => `${e.name} (${e.dateTaken})`).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Licenses:</span> ${(p.licenses || []).map((l) => `${l.name} (valid until ${l.validUntil})`).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Language Proficiency:</span> ${Object.keys(langProf).length ? Object.entries(langProf).map(([lang, ab]) => `${lang}: ${(ab as string[]).join("/")}`).join("; ") : "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">Work Experience</h3>
      ${
        (p.workExperiences || []).length
          ? `<div class="space-y-2 text-sm">${p.workExperiences
              .map((w) => `<div class="border rounded-lg p-3" style="border-color:var(--color-border)"><div class="font-semibold">${w.position} &mdash; ${w.companyName}</div><div style="color:var(--color-muted)">${w.address} &middot; ${w.status} &middot; ${w.dateFrom} to ${w.dateTo}</div></div>`)
              .join("")}</div>`
          : `<div class="text-sm space-y-1"><div><span style="color:var(--color-muted)">Most Recent Company:</span> ${p.companyName || "&mdash;"}</div><div><span style="color:var(--color-muted)">Position:</span> ${p.position || "&mdash;"}</div><div><span style="color:var(--color-muted)">Summary:</span> ${p.experience || "&mdash;"}</div></div>`
      }
    </div>
    <div class="card rounded-xl p-5">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">Requirements / Documents on File</h3>
      ${
        documents.length
          ? `<ul class="text-sm list-disc ml-5 space-y-1">${documents.map((d) => `<li>${d.name} <span style="color:var(--color-muted)">(${d.uploadedAt.slice(0, 10)})</span></li>`).join("")}</ul>`
          : `<p class="text-sm" style="color:var(--color-muted)">No documents on file.</p>`
      }
      <p class="text-[11px] mt-3" style="color:var(--color-muted)">Document files themselves are reviewed by PESO Staff as part of verification and aren't downloadable from here.</p>
    </div>
  `;
}

async function closeSeekerProfileModal() {
  $("seekerProfileOverlay").classList.add("hidden");
  $("seekerProfileModalBody").innerHTML = `<p class="text-sm p-8" style="color:var(--color-muted)">Loading profile&hellip;</p>`;
}

async function openEmployerSeekerProfile(applicationId: number) {
  $("seekerProfileOverlay").classList.remove("hidden");
  $("seekerProfileModalTitle").textContent = "Seeker Profile";
  $("seekerProfileModalBody").innerHTML = `<p class="text-sm p-8" style="color:var(--color-muted)">Loading profile&hellip;</p>`;
  try {
    const d = await api.getEmployerApplicantProfile(applicationId);
    $("seekerProfileModalTitle").textContent = d.profile.name || d.profile.email;
    $("seekerProfileModalBody").innerHTML = `
      <p class="text-xs mb-4" style="color:var(--color-muted)">Applied for ${d.vacancyTitle}</p>
      ${employerSeekerProfileSectionsHtml(d.profile, d.documents)}
    `;
  } catch (err) {
    $("seekerProfileModalBody").innerHTML = `<p class="text-sm p-8" style="color:#C0392B">${errMsg(err, "Could not load this seeker's profile.")}</p>`;
  }
}

async function renderEmployerDash(tab: string) {
  const content = $("dashContent");
  const u = currentUser;
  if (!u) return;

  if (tab === "overview") {
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Welcome, ${u.name}</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Here's a snapshot of your PESO employer account.</p>
      ${verificationStatusCardHtml(u)}
      <div id="employerOverviewBody" class="text-sm" style="color:var(--color-muted)">Loading&hellip;</div>
    `;
    try {
      employerVacancies = await api.getEmployerVacancies();
      employerApplicants = await api.getEmployerApplications();
    } catch {}
    if (currentUser?.role !== "employer" || currentDashTab !== "overview") return;
    const body = document.getElementById("employerOverviewBody");
    if (!body) return;
    const stat = (n: number, label: string) => `<div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${n}</div><div class="text-xs" style="color:var(--color-muted)">${label}</div></div>`;
    body.innerHTML = `
      <div class="grid sm:grid-cols-4 gap-4 mb-8 stagger-grid">
        ${stat(employerVacancies.length, "Total Job Vacancies")}
        ${stat(employerVacancies.filter((v) => v.status === "pending_approval").length, "Pending Vacancies")}
        ${stat(employerVacancies.filter((v) => v.status === "approved").length, "Approved Vacancies")}
        ${stat(employerVacancies.filter((v) => v.status === "rejected").length, "Rejected Vacancies")}
        ${stat(employerVacancies.filter((v) => v.status === "expired").length, "Expired Vacancies")}
        ${stat(employerApplicants.length, "Total Applications")}
        ${stat(employerApplicants.filter((a) => a.employerStatus === "under_employer_review" || !a.employerStatus).length, "Awaiting Your Review")}
        ${stat(employerApplicants.filter((a) => a.employerStatus === "accepted_hired" || employerVacancies.find((v) => v.id === a.vacancyId)?.status === "closed").length, "Hired / Closed")}
      </div>
      <div class="flex flex-wrap gap-2 mb-8">
        <button onclick="dashTab('profile')" class="text-xs font-semibold px-4 py-2 rounded-lg border" style="border-color:var(--color-border)">Complete Employer Profile</button>
        <button onclick="openNewVacancyForm()" class="btn-primary text-xs font-semibold px-4 py-2 rounded-lg">+ Add Job Vacancy</button>
        <button onclick="dashTab('vacancies')" class="text-xs font-semibold px-4 py-2 rounded-lg border" style="border-color:var(--color-border)">Manage Vacancies</button>
        <button onclick="dashTab('applications')" class="text-xs font-semibold px-4 py-2 rounded-lg border" style="border-color:var(--color-border)">View Applications</button>
      </div>
      <h3 class="font-semibold text-sm mb-3" style="color:var(--color-text)">Recent Vacancies</h3>
      <div class="space-y-3 stagger-grid">${employerVacancies.slice(0, 3).map(employerVacancyRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No vacancies yet.</p>`}</div>
    `;
    return;
  }

  if (tab === "profile") {
    if (!["draft", "returned_for_completion", "verified"].includes(u.verificationStatus)) {
      content.innerHTML = `
        <h1 class="font-display text-2xl font-semibold mb-1">Establishment Profile</h1>
        ${verificationStatusCardHtml(u)}
        <h3 class="font-semibold text-sm mb-3">Verification History</h3>
        ${historyTimelineHtml(myVerificationHistory)}
      `;
      return;
    }
    const complete = isEmployerProfileCompleteClient(u);
    const categories = EMPLOYER_TYPE_CATEGORIES[u.employerType] || [];
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Establishment Profile</h1>
      <p class="text-sm mb-4" style="color:var(--color-muted)">Based on PESO's NSRP Form 2 (Establishment Registration Form). <strong>Fields marked * are required.</strong> Changes to Business Name, TIN, or Employer Type require PESO Staff to re-verify your establishment.</p>
      ${
        u.verificationStatus === "returned_for_completion"
          ? `<div class="rounded-lg px-4 py-3 text-sm font-medium mb-4" style="background:#FBE3E1; color:#9B2C22">
              <p class="font-semibold mb-1">&#9888; Action Required: Your establishment profile was returned by PESO Staff</p>
              <p><strong>Staff Remarks:</strong> ${u.verificationRemarks || "See missing requirements below."}</p>
            </div>`
          : ""
      }
      ${u.verificationStatus === "verified" ? verificationStatusCardHtml(u) : ""}
      <form id="employerProfileForm" onsubmit="event.preventDefault(); saveEmployerProfile();" class="space-y-4">
        <div class="card rounded-xl p-6">
          <h4 class="text-xs font-bold uppercase tracking-wide mb-3" style="color:var(--color-muted)">Establishment Details</h4>
          <div class="grid sm:grid-cols-2 gap-3">
            <div><label for="epBusinessName" class="text-xs font-semibold block mb-1.5">Business Name *</label><input id="epBusinessName" value="${u.employerBusinessName}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epTradeName" class="text-xs font-semibold block mb-1.5">Trade Name</label><input id="epTradeName" value="${u.employerTradeName}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epAcronym" class="text-xs font-semibold block mb-1.5">Acronym/Abbreviation</label><input id="epAcronym" value="${u.employerAcronym}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epTin" class="text-xs font-semibold block mb-1.5">Tax Identification Number (TIN) *</label><input id="epTin" value="${u.employerTin}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div>
              <label for="epType" class="text-xs font-semibold block mb-1.5">Employer Type *</label>
              <select id="epType" onchange="employerTypeChanged()" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
                <option value="" ${!u.employerType ? "selected" : ""}>Select type</option>
                <option value="Public" ${u.employerType === "Public" ? "selected" : ""}>Public</option>
                <option value="Private" ${u.employerType === "Private" ? "selected" : ""}>Private</option>
              </select>
            </div>
            <div>
              <label for="epCategory" class="text-xs font-semibold block mb-1.5">Employer Classification</label>
              <select id="epCategory" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
                <option value="">Select classification</option>
                ${categories.map((c) => `<option ${u.employerCategory === c ? "selected" : ""}>${c}</option>`).join("")}
              </select>
            </div>
            <div>
              <label for="epNatureOfWork" class="text-xs font-semibold block mb-1.5">Nature of Work</label>
              <select id="epNatureOfWork" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
                <option value="">Select</option>
                ${NATURE_OF_WORK_OPTIONS.map((o) => `<option ${u.employerNatureOfWork === o ? "selected" : ""}>${o}</option>`).join("")}
              </select>
            </div>
            <div>
              <label for="epWorkforceSize" class="text-xs font-semibold block mb-1.5">Total Work Force</label>
              <select id="epWorkforceSize" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
                <option value="">Select</option>
                ${WORKFORCE_SIZE_OPTIONS.map((o) => `<option ${u.employerWorkforceSize === o ? "selected" : ""}>${o}</option>`).join("")}
              </select>
            </div>
            <div><label for="epIndustry" class="text-xs font-semibold block mb-1.5">Line of Business/Industry *</label><input id="epIndustry" value="${u.employerIndustry}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epStreet" class="text-xs font-semibold block mb-1.5">Street/Village *</label><input id="epStreet" value="${u.employerStreet}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epBarangay" class="text-xs font-semibold block mb-1.5">Barangay *</label><input id="epBarangay" value="${u.employerBarangay}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epMunicipality" class="text-xs font-semibold block mb-1.5">Municipality/City *</label><input id="epMunicipality" value="${u.employerMunicipality || "Gingoog City"}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epProvince" class="text-xs font-semibold block mb-1.5">Province *</label><input id="epProvince" value="${u.employerProvince || "Misamis Oriental"}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
        </div>
        <div class="card rounded-xl p-6">
          <h4 class="text-xs font-bold uppercase tracking-wide mb-3" style="color:var(--color-muted)">Establishment Contact Details</h4>
          <div class="grid sm:grid-cols-2 gap-3">
            <div><label for="epOwnerName" class="text-xs font-semibold block mb-1.5">Name of Owner/President *</label><input id="epOwnerName" value="${u.employerOwnerName}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epContactPerson" class="text-xs font-semibold block mb-1.5">Contact Person (Full Name) *</label><input id="epContactPerson" value="${u.employerContactPerson}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epPosition" class="text-xs font-semibold block mb-1.5">Position *</label><input id="epPosition" value="${u.employerPosition}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epTelephone" class="text-xs font-semibold block mb-1.5">Telephone Number</label><input id="epTelephone" value="${u.employerTelephone}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epMobile" class="text-xs font-semibold block mb-1.5">Mobile Number *</label><input id="epMobile" value="${u.employerMobile}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epFax" class="text-xs font-semibold block mb-1.5">Fax Number</label><input id="epFax" value="${u.employerFax}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
            <div><label for="epEmail" class="text-xs font-semibold block mb-1.5">Email Address *</label><input id="epEmail" type="email" value="${u.employerEmail}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          </div>
        </div>
        <div class="card rounded-xl p-6">
          <label for="epDescription" class="text-xs font-semibold block mb-1.5">About the Establishment</label>
          <textarea id="epDescription" rows="3" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">${u.employerDescription}</textarea>
        </div>
        <div class="card rounded-xl p-6">
          <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">Requirements / Documents</h3>
          <input id="pDocInput" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" class="hidden" onchange="handleDocUpload(this.files)">
          <button type="button" onclick="document.getElementById('pDocInput').click()" class="w-full border-2 border-dashed rounded-lg p-6 text-center text-xs hover:bg-black/[0.02] transition-colors" style="border-color:var(--color-border); color:var(--color-muted)">
            Drag files here or <span class="font-semibold" style="color:var(--color-primary)">browse</span> &mdash; Business Permit, DTI/SEC Registration, other company documents
          </button>
          <div id="pDocList" class="mt-3 space-y-2">${docListHtml()}</div>
          <p class="text-[11px] mt-3" style="color:var(--color-muted)">Files are uploaded straight to the PESO server as you attach them (8MB limit each) &mdash; no need to click Save Progress for these.</p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button type="submit" class="btn-outline px-6 py-2.5 rounded-lg text-sm font-semibold">Save Progress</button>
          ${
            u.verificationStatus !== "verified"
              ? `<button type="button" onclick="doSubmitEmployerProfileForVerification()" class="btn-primary px-6 py-2.5 rounded-lg text-sm font-semibold" ${complete ? "" : "disabled style=\"opacity:0.5; cursor:not-allowed\""}>
                  ${u.verificationStatus === "returned_for_completion" ? "Resubmit for Verification" : "Submit for Verification"}
                </button>
                ${!complete ? `<span class="text-xs" style="color:var(--color-muted)">Complete every required field above to submit.</span>` : ""}`
              : ""
          }
        </div>
      </form>
    `;
    return;
  }

  if (tab === "vacancies") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Job Vacancies</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      employerVacancies = await api.getEmployerVacancies();
      employerApplicants = await api.getEmployerApplications();
    } catch {}
    if (currentUser?.role !== "employer" || currentDashTab !== "vacancies") return;
    const canPost = u.verificationStatus === "verified";
    if (!canPost) {
      showVacancyForm = false;
      editingVacancyId = null;
    }
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Job Vacancies</h1>
      <p class="text-sm mb-4" style="color:var(--color-muted)">Save vacancies as a draft any time. Every vacancy is reviewed and approved by PESO Staff before it becomes visible to Job Seekers.</p>
      ${
        canPost
          ? `<button onclick="toggleNewVacancyForm()" class="btn-primary text-sm font-semibold px-4 py-2 rounded-lg mb-4">${showVacancyForm && !editingVacancyId ? "Cancel" : "+ Add Job Vacancy"}</button>`
          : u.verificationStatus === "suspended"
            ? `<div class="rounded-lg px-4 py-3 text-xs font-medium mb-4" style="background:#E6E6E6; color:#3A3A3A">Your establishment account is suspended. Contact PESO Staff for assistance.</div>`
            : `<div class="rounded-lg px-4 py-3 text-xs font-medium mb-4" style="background:#FCEFD9; color:#8A5A0F">Your establishment must be verified by PESO Staff before you can add job vacancies. <button onclick="dashTab('profile')" class="underline font-semibold">Go to Establishment Profile &rarr;</button></div>`
      }
      ${canPost && showVacancyForm ? vacancyFormHtml(editingVacancyId ? employerVacancies.find((v) => v.id === editingVacancyId) : undefined) : ""}
      <div class="space-y-3 stagger-grid">${employerVacancies.map(employerVacancyRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No vacancies posted yet.</p>`}</div>
    `;
    if (canPost && showVacancyForm) {
      mountVacancyLocationPicker(editingVacancyId ? employerVacancies.find((v) => v.id === editingVacancyId) : undefined);
    }
    return;
  }

  if (tab === "applications") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Applications</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      employerApplicants = await api.getEmployerApplications();
    } catch {}
    if (currentUser?.role !== "employer" || currentDashTab !== "applications") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Applications</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Verified Job Seekers apply directly to your postings. Review each applicant and update their status &mdash; PESO Staff can see the outcome for monitoring, but the decision is yours.</p>
      <div class="space-y-3 stagger-grid">${employerApplicants.map(employerApplicantRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No applications yet.</p>`}</div>
    `;
    return;
  }

  if (tab === "notifications") {
    if (currentNotifications().some((n) => !n.read)) api.markAllNotificationsRead().catch(() => {});
    currentNotifications().forEach((n) => (n.read = true));
    content.innerHTML = notificationsTabHtml("Updates about your verification, vacancy approvals, and referrals.");
  }
}

function employerTypeChanged() {
  const type = ($("epType") as HTMLSelectElement).value;
  const categorySelect = $("epCategory") as HTMLSelectElement;
  const categories = EMPLOYER_TYPE_CATEGORIES[type] || [];
  categorySelect.innerHTML = `<option value="">Select classification</option>${categories.map((c) => `<option>${c}</option>`).join("")}`;
}

/* ================================================================
 * STAFF DASHBOARD — Job Seeker / Employer verification, vacancy approval
 * ================================================================ */
let staffSeekerFilter = "pending_verification";
let staffEmployerFilter = "pending_verification";
let staffVacancyFilter = "pending_approval";
let staffSeekersList: (AuthUser & { documentCount: number })[] = [];
let staffEmployersList: AuthUser[] = [];
let staffVacanciesList: Vacancy[] = [];
let staffApplicationsList: (Application & { seekerEmail: string; seekerName: string; seekerContact: string; vacancyTitle: string; vacancyEmployer: string })[] = [];
/** Keep detail state independent between verification sections; dashTab clears the
 * active section's detail when Staff navigates away so returning always shows its list. */
let staffSeekerDetailEmail: string | null = null;
let staffEmployerDetailEmail: string | null = null;
let staffSeekerDetail: { profile: AuthUser; documents: DocumentMeta[]; applications: (Application & { vacancyTitle?: string; vacancyEmployer?: string })[]; history: VerificationHistoryEntry[] } | null = null;
let staffEmployerDetail: { profile: AuthUser; vacancies: Vacancy[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] } | null = null;
type ReturnCompletionTarget =
  | { type: "seeker"; email: string }
  | { type: "employer"; email: string }
  | { type: "vacancy"; id: number };
let returnCompletionTarget: ReturnCompletionTarget | null = null;
let returnCompletionSubmitting = false;

function clearStaffReviewDetail(tab?: string) {
  if (!tab || tab === "seekers") {
    staffSeekerDetailEmail = null;
    staffSeekerDetail = null;
  }
  if (!tab || tab === "employers") {
    staffEmployerDetailEmail = null;
    staffEmployerDetail = null;
  }
}

/* ---- Section 3: Refer Seeker state ---- */
let referApprovedVacancies: Vacancy[] = [];
let referSelectedVacancyId: number | null = null;
let referCandidates: api.ReferralCandidate[] = [];
let referBusy = false;

const STATUS_FILTER_OPTIONS = [
  { value: "", label: "All" },
  { value: "draft", label: "Incomplete (Draft)" },
  { value: "pending_verification", label: "Pending Verification" },
  { value: "returned_for_completion", label: "Returned for Completion" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "suspended", label: "Suspended" },
];
function statusFilterSelectHtml(id: string, current: string, onchange: string): string {
  return `<select id="${id}" onchange="${onchange}" class="border rounded-lg px-3 py-2 text-xs font-semibold" style="border-color:var(--color-border)">
    ${STATUS_FILTER_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === current ? "selected" : ""}>${o.label}</option>`).join("")}
  </select>`;
}

function staffFilterSeekers() {
  staffSeekerFilter = ($("staffSeekerFilterSelect") as HTMLSelectElement).value;
  dashTabInner("seekers");
}
function staffFilterEmployers() {
  staffEmployerFilter = ($("staffEmployerFilterSelect") as HTMLSelectElement).value;
  dashTabInner("employers");
}

async function staffOpenSeekerDetail(email: string) {
  staffSeekerDetailEmail = email;
  try {
    const detail = await api.staffGetSeeker(email);
    if (currentUser?.role !== "staff" || currentDashTab !== "seekers" || staffSeekerDetailEmail !== email) return;
    staffSeekerDetail = detail;
  } catch (err) {
    if (staffSeekerDetailEmail === email) {
      staffSeekerDetailEmail = null;
      staffSeekerDetail = null;
    }
    showToast(errMsg(err, "Could not load this profile."));
    return;
  }
  if (currentUser?.role === "staff" && currentDashTab === "seekers" && staffSeekerDetailEmail === email) {
    dashTabInner("seekers");
  }
}
async function staffOpenEmployerDetail(email: string) {
  staffEmployerDetailEmail = email;
  try {
    const detail = await api.staffGetEmployer(email);
    if (currentUser?.role !== "staff" || currentDashTab !== "employers" || staffEmployerDetailEmail !== email) return;
    staffEmployerDetail = detail;
  } catch (err) {
    if (staffEmployerDetailEmail === email) {
      staffEmployerDetailEmail = null;
      staffEmployerDetail = null;
    }
    showToast(errMsg(err, "Could not load this profile."));
    return;
  }
  if (currentUser?.role === "staff" && currentDashTab === "employers" && staffEmployerDetailEmail === email) {
    dashTabInner("employers");
  }
}
function staffBackFromSeekerDetail() {
  staffSeekerDetailEmail = null;
  staffSeekerDetail = null;
  dashTabInner("seekers");
}
function staffBackFromEmployerDetail() {
  staffEmployerDetailEmail = null;
  staffEmployerDetail = null;
  dashTabInner("employers");
}

function openReturnCompletionModal(target: ReturnCompletionTarget) {
  returnCompletionTarget = target;
  const audience = target.type === "seeker" ? "Job Seeker" : target.type === "employer" ? "Employer" : "Employer";
  const title = target.type === "vacancy" ? "Return Vacancy for Changes" : "Return Profile for Completion";
  $("returnCompletionTitle").textContent = title;
  $("returnCompletionDescription").textContent = target.type === "vacancy"
    ? `Describe exactly what needs to change before this vacancy can be approved. Your message will be shown to the ${audience.toLowerCase()}.`
    : `Describe exactly what is missing or incorrect. Your message will be shown to the ${audience}.`;
  $<HTMLTextAreaElement>("returnCompletionRemarks").value = "";
  $("returnCompletionError").classList.add("hidden");
  $("returnCompletionSubmit").textContent = target.type === "vacancy" ? "Send for Changes" : "Send for Completion";
  $("returnCompletionOverlay").classList.remove("hidden");
  $<HTMLTextAreaElement>("returnCompletionRemarks").focus();
}

function closeReturnCompletionModal() {
  if (returnCompletionSubmitting) return;
  $("returnCompletionOverlay").classList.add("hidden");
  $<HTMLTextAreaElement>("returnCompletionRemarks").value = "";
  $("returnCompletionError").classList.add("hidden");
  returnCompletionTarget = null;
}

function clearReturnCompletionError() {
  $("returnCompletionError").classList.add("hidden");
}

async function submitReturnForCompletion() {
  const target = returnCompletionTarget;
  if (!target || returnCompletionSubmitting) return;
  const remarks = $<HTMLTextAreaElement>("returnCompletionRemarks").value.trim();
  if (!remarks) {
    $("returnCompletionError").classList.remove("hidden");
    $<HTMLTextAreaElement>("returnCompletionRemarks").focus();
    return;
  }

  const submitButton = $("returnCompletionSubmit") as HTMLButtonElement;
  const cancelButton = $("returnCompletionForm").querySelector<HTMLButtonElement>('button[type="button"]');
  returnCompletionSubmitting = true;
  submitButton.disabled = true;
  if (cancelButton) cancelButton.disabled = true;
  submitButton.textContent = "Sending…";
  try {
    if (target.type === "seeker") {
      await api.staffReturnSeeker(target.email, remarks);
      returnCompletionSubmitting = false;
      closeReturnCompletionModal();
      showToast("Profile returned to the Job Seeker for completion.");
      await staffOpenSeekerDetail(target.email);
    } else if (target.type === "employer") {
      await api.staffReturnEmployer(target.email, remarks);
      returnCompletionSubmitting = false;
      closeReturnCompletionModal();
      showToast("Profile returned to the Employer for completion.");
      await staffOpenEmployerDetail(target.email);
    } else {
      await api.staffReturnVacancy(target.id, remarks);
      returnCompletionSubmitting = false;
      closeReturnCompletionModal();
      showToast("Vacancy returned to the employer for changes.");
      dashTabInner("vacancies");
    }
  } catch (err) {
    showToast(errMsg(err, "Could not return this item for completion."));
  } finally {
    returnCompletionSubmitting = false;
    submitButton.disabled = false;
    if (cancelButton) cancelButton.disabled = false;
    if (!returnCompletionTarget) submitButton.textContent = "Send for Completion";
    else submitButton.textContent = returnCompletionTarget.type === "vacancy" ? "Send for Changes" : "Send for Completion";
  }
}

async function staffVerifySeekerAction(email: string) {
  try {
    await api.staffVerifySeeker(email);
    showToast("Profile verified.");
    await staffOpenSeekerDetail(email);
  } catch (err) {
    showToast(errMsg(err, "Could not verify this profile."));
  }
}
function staffReturnSeekerAction(email: string) {
  openReturnCompletionModal({ type: "seeker", email });
}
async function staffRejectSeekerAction(email: string) {
  const remarks = window.prompt("Reason for rejecting this profile (shown to the Job Seeker, optional):") ?? "";
  if (!window.confirm("Reject this profile? This is a stronger action than Return for Completion.")) return;
  try {
    await api.staffRejectSeeker(email, remarks.trim());
    showToast("Profile rejected.");
    await staffOpenSeekerDetail(email);
  } catch (err) {
    showToast(errMsg(err, "Could not reject this profile."));
  }
}
async function staffVerifyEmployerAction(email: string) {
  try {
    await api.staffVerifyEmployer(email);
    showToast("Employer verified.");
    await staffOpenEmployerDetail(email);
  } catch (err) {
    showToast(errMsg(err, "Could not verify this employer."));
  }
}
function staffReturnEmployerAction(email: string) {
  openReturnCompletionModal({ type: "employer", email });
}
async function staffRejectEmployerAction(email: string) {
  const remarks = window.prompt("Reason for rejecting this employer (optional):") ?? "";
  if (!window.confirm("Reject this employer profile?")) return;
  try {
    await api.staffRejectEmployer(email, remarks.trim());
    showToast("Employer profile rejected.");
    await staffOpenEmployerDetail(email);
  } catch (err) {
    showToast(errMsg(err, "Could not reject this employer."));
  }
}
async function staffApproveVacancyAction(id: number) {
  try {
    await api.staffApproveVacancy(id);
    await refreshVacancies();
    showToast("Vacancy approved and is now visible to Job Seekers.");
    dashTabInner("vacancies");
  } catch (err) {
    showToast(errMsg(err, "Could not approve this vacancy."));
  }
}
function staffReturnVacancyAction(id: number) {
  openReturnCompletionModal({ type: "vacancy", id });
}
async function staffRejectVacancyAction(id: number) {
  const remarks = window.prompt("Reason for rejecting this vacancy (shown to the employer):");
  if (!remarks || !remarks.trim()) return;
  try {
    await api.staffRejectVacancy(id, remarks.trim());
    showToast("Vacancy rejected.");
    dashTabInner("vacancies");
  } catch (err) {
    showToast(errMsg(err, "Could not reject this vacancy."));
  }
}
async function staffSuspendEmployerAction(email: string) {
  const remarks = window.prompt("Reason for suspending this establishment (shown to the employer):") ?? "";
  if (!window.confirm("Suspend this employer? They won't be able to post new vacancies until reactivated.")) return;
  try {
    await api.staffSuspendEmployer(email, remarks.trim());
    showToast("Employer suspended.");
    await staffOpenEmployerDetail(email);
  } catch (err) {
    showToast(errMsg(err, "Could not suspend this employer."));
  }
}
async function staffReactivateEmployerAction(email: string) {
  try {
    await api.staffReactivateEmployer(email);
    showToast("Employer reactivated.");
    await staffOpenEmployerDetail(email);
  } catch (err) {
    showToast(errMsg(err, "Could not reactivate this employer."));
  }
}

function staffSeekerListRow(s: AuthUser & { documentCount: number }): string {
  const meta = VERIFICATION_STATUS_META[s.verificationStatus] || VERIFICATION_STATUS_META.draft;
  return `
    <div class="card rounded-xl p-4 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-sm truncate">${s.name || s.email}</div>
        <div class="text-xs truncate" style="color:var(--color-muted)">${s.email} &middot; Submitted ${s.verificationSubmittedAt ? s.verificationSubmittedAt.slice(0, 10) : "&mdash;"} &middot; ${s.documentCount} doc(s)</div>
        ${s.verificationStatus === "draft" ? registrationExpiryTimerHtml(s.registrationExpiresAt) : ""}
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full" style="background:${meta.bg}; color:${meta.fg}">${meta.label}</span>
        <button onclick="staffOpenSeekerDetail('${s.email}')" class="btn-outline text-xs font-semibold px-3 py-1.5 rounded-lg">Review</button>
      </div>
    </div>`;
}
function staffEmployerListRow(e: AuthUser): string {
  const meta = VERIFICATION_STATUS_META[e.verificationStatus] || VERIFICATION_STATUS_META.draft;
  return `
    <div class="card rounded-xl p-4 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-sm truncate">${e.employerBusinessName || e.employerCompanyName || e.name || e.email}</div>
        <div class="text-xs truncate" style="color:var(--color-muted)">${e.email} &middot; Submitted ${e.verificationSubmittedAt ? e.verificationSubmittedAt.slice(0, 10) : "&mdash;"}</div>
        ${e.verificationStatus === "draft" ? registrationExpiryTimerHtml(e.registrationExpiresAt) : ""}
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full" style="background:${meta.bg}; color:${meta.fg}">${meta.label}</span>
        <button onclick="staffOpenEmployerDetail('${e.email}')" class="btn-outline text-xs font-semibold px-3 py-1.5 rounded-lg">Review</button>
      </div>
    </div>`;
}
function staffVacancyApprovalRow(v: Vacancy): string {
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-start justify-between gap-3 mb-1">
        <div>
          <h4 class="font-semibold text-sm">${v.title}</h4>
          <p class="text-xs" style="color:var(--color-muted)">${v.employer} &middot; ${v.employerEmail} &middot; ${v.category} &middot; ${v.location}</p>
        </div>
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0" style="background:${(VACANCY_STATUS_META[v.status] || VACANCY_STATUS_META.pending_approval).bg}; color:${(VACANCY_STATUS_META[v.status] || VACANCY_STATUS_META.pending_approval).fg}">${(VACANCY_STATUS_META[v.status] || VACANCY_STATUS_META.pending_approval).label}</span>
      </div>
      <p class="text-xs mb-3" style="color:var(--color-muted)">${v.description}</p>
      <div class="flex flex-wrap gap-2">
        <button onclick="openVacancyDetailModal(${v.id})" class="text-xs font-semibold px-4 py-2 rounded-lg border" style="border-color:var(--color-border)">View Full Details</button>
        ${
          v.status === "pending_approval"
            ? `<button onclick="staffApproveVacancyAction(${v.id})" class="btn-primary text-xs font-semibold px-4 py-2 rounded-lg">Approve Vacancy</button>
              <button onclick="staffReturnVacancyAction(${v.id})" class="text-xs font-semibold px-4 py-2 rounded-lg border" style="border-color:var(--color-border)">Return for Changes</button>
              <button onclick="staffRejectVacancyAction(${v.id})" class="text-xs font-semibold px-4 py-2 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Reject</button>`
            : ""
        }
      </div>
    </div>`;
}

/** Staff Vacancy Approvals "View Full Details" (this request): before deciding to
 * Approve, Return for Changes, or Reject, Staff can see every field the Employer
 * actually submitted — not just the short summary shown on the approval card. */
function vacancyDetailField(label: string, value: string | number | undefined | null): string {
  const display = value === undefined || value === null || value === "" ? "&mdash;" : String(value);
  return `<div><div class="text-[11px] uppercase tracking-wide" style="color:var(--color-muted)">${label}</div><div class="text-sm font-medium">${display}</div></div>`;
}
function vacancyDetailModalHtml(v: Vacancy): string {
  const meta = VACANCY_STATUS_META[v.status] || VACANCY_STATUS_META.pending_approval;
  const mapCoordinates = validMapCoordinates(v.latitude, v.longitude);
  return `
    <div class="mb-4 flex items-center gap-2">
      <span class="text-xs font-semibold px-2.5 py-1 rounded-full" style="background:${meta.bg}; color:${meta.fg}">${meta.label}</span>
      <span class="text-xs" style="color:var(--color-muted)">Posted ${v.posted}</span>
    </div>
    ${v.remarks && (v.status === "returned_for_completion" || v.status === "rejected") ? `<p class="text-xs mb-4 rounded-lg px-3 py-2" style="background:#FBE3E1; color:#9B2C22"><strong>Staff Remarks:</strong> ${v.remarks}</p>` : ""}

    <h4 class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--color-primary)">Vacancy Details</h4>
    <div class="grid sm:grid-cols-2 gap-3 mb-4">
      ${vacancyDetailField("Position Title", v.title)}
      ${vacancyDetailField("Employer", `${v.employer} (${v.employerEmail})`)}
      ${vacancyDetailField("Category", v.category)}
      ${vacancyDetailField("Nature of Work", v.type)}
      ${vacancyDetailField("Place of Work", v.location)}
      ${vacancyDetailField("Salary", formatSalary(v.salary))}
      ${vacancyDetailField("Vacancy Count (Slots)", v.slots)}
      ${vacancyDetailField("Valid Until", v.validUntil)}
    </div>
    ${
      mapCoordinates
        ? `<div class="mb-4"><div class="text-[11px] uppercase tracking-wide mb-2" style="color:var(--color-muted)">Pinned Job Location</div><div id="staffVacancyMap-${v.id}" class="location-map rounded-lg border" style="height:280px;border-color:var(--color-border)"></div></div>`
        : ""
    }
    <div class="mb-4"><div class="text-[11px] uppercase tracking-wide mb-1" style="color:var(--color-muted)">Job Description</div><p class="text-sm">${v.description || "&mdash;"}</p></div>

    <h4 class="text-xs font-bold uppercase tracking-wide mb-2" style="color:var(--color-primary)">Qualification Requirements</h4>
    <div class="grid sm:grid-cols-2 gap-3 mb-4">
      ${vacancyDetailField("Work Experience", v.workExperience)}
      ${vacancyDetailField("Minimum Education Level", v.minEducationLevel)}
      ${vacancyDetailField("Course/SHS Strand", v.courseShsStrand)}
      ${vacancyDetailField("Required Skills", (v.requiredSkills || []).join(", "))}
      ${vacancyDetailField("Minimum Years of Experience", v.minExperienceYears)}
      ${vacancyDetailField("License", v.license)}
      ${vacancyDetailField("Certification", v.certification)}
      ${vacancyDetailField("Eligibility", v.eligibility)}
      ${vacancyDetailField("Language/Dialect", v.languageDialect)}
      ${vacancyDetailField("Accepts PWD Applicants", v.acceptsPwd)}
      ${v.acceptsPwd === "Yes" ? vacancyDetailField("PWD Types Accepted", (v.pwdTypes || []).join(", ")) : ""}
      ${vacancyDetailField("Accepts Returning OFW", v.acceptsReturningOfw)}
    </div>
    <div class="mb-1"><div class="text-[11px] uppercase tracking-wide mb-1" style="color:var(--color-muted)">Other Qualifications</div><p class="text-sm">${v.otherQualifications || "&mdash;"}</p></div>
    ${(v.qualification || []).length ? `<div class="mt-3"><div class="text-[11px] uppercase tracking-wide mb-1" style="color:var(--color-muted)">Qualification Summary</div><ul class="text-sm list-disc pl-5">${(v.qualification || []).map((q) => `<li>${q}</li>`).join("")}</ul></div>` : ""}
  `;
}
function openVacancyDetailModal(id: number) {
  const v = staffVacanciesList.find((x) => x.id === id);
  const overlay = $("vacancyDetailOverlay");
  const title = $("vacancyDetailModalTitle");
  const body = $("vacancyDetailModalBody");
  if (!v) {
    body.innerHTML = `<p class="text-sm p-8" style="color:#C0392B">Could not find this vacancy.</p>`;
    overlay.classList.remove("hidden");
    return;
  }
  title.textContent = v.title || "Vacancy Details";
  body.innerHTML = vacancyDetailModalHtml(v);
  overlay.classList.remove("hidden");
  const mapCoordinates = validMapCoordinates(v.latitude, v.longitude);
  if (mapCoordinates) {
    requestAnimationFrame(() => mountLocationMap(`staffVacancyMap-${v.id}`, mapCoordinates));
  }
}
function openVacancyDetailsModal(id: number) {
  const vacancy = vacancies.find((item) => item.id === id)
    || pendingStaffReferrals.find((referral) => referral.vacancy.id === id)?.vacancy;
  const overlay = $("vacancyDetailOverlay");
  const title = $("vacancyDetailModalTitle");
  const body = $("vacancyDetailModalBody");
  if (!vacancy) {
    body.innerHTML = `<p class="text-sm p-8" style="color:#C0392B">Could not find this vacancy.</p>`;
    overlay.classList.remove("hidden");
    return;
  }
  const referral = pendingStaffReferrals.find((item) => item.vacancy.id === id);
  const alreadyApplied = currentApplications().some((application) => application.vacancyId === id);
  title.textContent = vacancy.title || "Vacancy Details";
  body.innerHTML = `${vacancyDetailModalHtml(vacancy)}
    ${referral ? `<p class="rounded-lg px-4 py-3 text-sm mt-4" style="background:#DCEAF7; color:#1D5A85">PESO Staff invited you to review this job on ${referral.createdAt.slice(0, 10)}. Applying is your choice.</p>` : ""}
    ${currentUser?.role === "job_seeker" && alreadyApplied
      ? `<p class="rounded-lg px-4 py-3 text-sm font-medium mt-4" style="background:#E4EEDD; color:#3F6B2E">You have already applied to this vacancy.</p>`
      : referral && currentUser?.role === "job_seeker"
        ? `<div class="flex justify-end gap-2 mt-4">
            <button onclick="applyToJob(${vacancy.id}, true)" class="btn-primary px-6 py-3 rounded-lg text-sm font-semibold">Apply</button>
            <button onclick="cancelStaffReferralAction(${referral.id})" class="text-sm font-semibold px-6 py-3 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Cancel</button>
          </div>`
        : ""}`;
  overlay.classList.remove("hidden");
  const mapCoordinates = validMapCoordinates(vacancy.latitude, vacancy.longitude);
  if (mapCoordinates) {
    requestAnimationFrame(() => mountLocationMap(`staffVacancyMap-${vacancy.id}`, mapCoordinates));
  }
}
function closeVacancyDetailModal() {
  $("vacancyDetailOverlay").classList.add("hidden");
}

function staffApplicationRow(a: Application & { seekerEmail: string; seekerName: string; seekerContact?: string; vacancyTitle: string; vacancyEmployer: string }): string {
  const isHired = a.employerStatus === "accepted_hired" || a.status === "hired";
  const seekerEmail = escapeReportHtml(a.seekerEmail);
  const seekerContact = escapeReportHtml(a.seekerContact || "");
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-start justify-between gap-3 mb-2">
        <div>
          <h4 class="font-semibold text-sm">${escapeReportHtml(a.seekerName || a.seekerEmail)} ${a.isStaffReferral ? `<span class="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ml-1" style="background:#DCEAF7; color:#1D5A85">Staff Referral</span>` : ""}</h4>
          <p class="text-xs" style="color:var(--color-muted)">${escapeReportHtml(a.vacancyTitle)} at ${escapeReportHtml(a.vacancyEmployer)} &middot; Applied ${escapeReportHtml(a.dateApplied)}</p>
        </div>
        <span class="status-pill ${(STATUS_META[a.status] || STATUS_META.pending).pill} flex-shrink-0">${(STATUS_META[a.status] || STATUS_META.pending).label}</span>
      </div>
      <p class="text-xs" style="color:var(--color-muted)">Employer decision: ${a.employerStatus ? (EMPLOYER_STATUS_LABELS[a.employerStatus] || a.employerStatus) : "Not yet reviewed by the employer"}</p>
      ${isHired ? `
        <div class="rounded-xl p-4 mt-4 border" style="background:#F2F7EF;border-color:#D7E5D0;color:#285B38">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style="background:#E1EEDB">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold">Hired — referral letter follow-up</p>
              <p class="text-xs mt-1 leading-relaxed">Please contact the seeker to arrange collection of their PESO referral letter.</p>
              <div class="mt-3 space-y-1.5 text-xs">
                <p class="break-all"><span class="font-semibold">Email:</span> ${seekerEmail}</p>
                <p><span class="font-semibold">Phone:</span> ${seekerContact || "Not provided"}</p>
              </div>
              <button type="button" data-email="${escapeReportHtml(a.seekerEmail)}" data-name="${escapeReportHtml(a.seekerName || "")}" data-vacancy="${escapeReportHtml(a.vacancyTitle)}" onclick="openSeekerEmailModal(${a.id}, this.dataset.email, this.dataset.name, this.dataset.vacancy)" class="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg text-xs font-semibold text-white shadow-sm" style="background:var(--color-primary)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
                Email seeker
              </button>
            </div>
          </div>
        </div>` : ""}
      ${currentUser?.role === "admin" ? `<div class="mt-3"><button onclick="adminDeleteApplicationAction(${a.id})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Delete Application</button></div>` : ""}
    </div>`;
}

let seekerEmailApplicationId: number | null = null;
function openSeekerEmailModal(applicationId: number, email: string, seekerName: string, vacancyTitle: string) {
  seekerEmailApplicationId = applicationId;
  $("seekerEmailRecipient").textContent = `${seekerName || "Job seeker"} <${email}>`;
  ($("seekerEmailMessage") as HTMLTextAreaElement).value = `Congratulations on being hired for ${vacancyTitle}.\n\nPlease contact or visit the PESO office to arrange the collection of your referral letter.\n\nRegards,\nPESO Gingoog City`;
  $("seekerEmailError").textContent = "";
  $("seekerEmailError").classList.add("hidden");
  ($("seekerEmailSubmit") as HTMLButtonElement).disabled = false;
  $("seekerEmailSubmit").textContent = "Send email";
  $("seekerEmailOverlay").classList.remove("hidden");
  requestAnimationFrame(() => $("seekerEmailMessage").focus());
}

function closeSeekerEmailModal() {
  $("seekerEmailOverlay").classList.add("hidden");
  seekerEmailApplicationId = null;
}

async function submitSeekerEmail() {
  if (seekerEmailApplicationId === null) return;
  const message = ($("seekerEmailMessage") as HTMLTextAreaElement).value.trim();
  const error = $("seekerEmailError");
  if (!message) {
    error.textContent = "Please enter a message before sending.";
    error.classList.remove("hidden");
    return;
  }
  const submit = $("seekerEmailSubmit") as HTMLButtonElement;
  submit.disabled = true;
  submit.textContent = "Sending...";
  error.textContent = "";
  error.classList.add("hidden");
  try {
    await api.staffSendSeekerEmail(seekerEmailApplicationId, message);
    closeSeekerEmailModal();
    showToast("Email sent to the seeker.");
  } catch (err) {
    error.textContent = errMsg(err, "Could not send this email. Please try again.");
    error.classList.remove("hidden");
    submit.disabled = false;
    submit.textContent = "Send email";
  }
}

/** Section 34: the complete Job Seeker profile view — every stored field, organized into
 * the Roman-numeral sections the spec calls for, with real document previews (not just
 * filenames) under section VIII. Shared by both the Staff and Admin detail pages so the
 * two views can never drift out of sync with each other. */
function fullSeekerProfileSectionsHtml(p: AuthUser, documents: DocumentMeta[]): string {
  const langProf = p.languageProficiency || {};
  return `
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">I. Personal Information</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Full Name:</span> ${[p.firstName, p.middleName, p.surname, p.suffix].filter(Boolean).join(" ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Sex:</span> ${p.sex || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Date of Birth:</span> ${p.dateOfBirth || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Civil Status:</span> ${p.civilStatus || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Religion:</span> ${p.religion || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Height (ft):</span> ${p.heightFt || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">TIN:</span> ${p.tin || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">4Ps Member:</span> ${p.is4Ps || "&mdash;"} ${p.householdIdNo ? `(HH ID: ${p.householdIdNo})` : ""}</div>
        <div class="sm:col-span-2"><span style="color:var(--color-muted)">Disability:</span> ${(p.disabilityTypes || []).join(", ") || "None declared"} ${p.disabilityOthers ? `&mdash; ${p.disabilityOthers}` : ""}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">II. Contact Information</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Email:</span> ${p.email}</div>
        <div><span style="color:var(--color-muted)">Contact Number:</span> ${p.contactNumber || "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">III. Address</h3>
      <div class="text-sm">${[p.houseStreet, p.barangay, p.municipality, p.province].filter(Boolean).join(", ") || "&mdash;"}</div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">IV. Employment Status &amp; Job Preferences</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Employment Status:</span> ${p.employmentStatus || "&mdash;"} ${p.employmentSubType ? `(${p.employmentSubType})` : ""}</div>
        <div><span style="color:var(--color-muted)">Months Looking for Work:</span> ${p.monthsLookingForWork || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Job Seeker Category:</span> ${(p.jobSeekerCategory || []).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">OFW:</span> ${p.isOFW || "&mdash;"} ${p.ofwCountry ? `(${p.ofwCountry})` : ""}</div>
        <div><span style="color:var(--color-muted)">Preferred Occupation:</span> ${[p.preferredOccupation1, p.preferredOccupation2].filter(Boolean).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Work Type / Location:</span> ${p.workType || "&mdash;"} / ${p.workLocation || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Preferred Local Areas:</span> ${(p.preferredLocalAreas || []).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Preferred Overseas Countries:</span> ${(p.preferredOverseasCountries || []).join(", ") || "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">V. Education</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Currently in School:</span> ${p.currentlyInSchool || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Education Level:</span> ${p.educationLevel || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Course:</span> ${p.course || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Year Graduated:</span> ${p.yearGraduated || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Undergrad Level Reached:</span> ${p.undergradLevelReached || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Undergrad Year Last Attended:</span> ${p.undergradYearLastAttended || "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">VI. Skills, Trainings, Eligibilities &amp; Licenses</h3>
      <div class="text-sm space-y-2">
        <div><span style="color:var(--color-muted)">Skills:</span> ${p.skills || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Other Skills:</span> ${(p.otherSkills || []).join(", ") || "&mdash;"} ${p.otherSkillsCustom ? `&mdash; ${p.otherSkillsCustom}` : ""}</div>
        <div><span style="color:var(--color-muted)">Technical/Vocational Training:</span> ${p.technicalTraining || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Trainings:</span> ${
          (p.trainings || []).length
            ? `<ul class="list-disc ml-5 mt-1">${p.trainings.map((t) => `<li>${t.course} &mdash; ${t.institution} (${t.hours} hrs)${t.skillsAcquired ? `: ${t.skillsAcquired}` : ""}</li>`).join("")}</ul>`
            : "&mdash;"
        }</div>
        <div><span style="color:var(--color-muted)">Eligibilities:</span> ${(p.eligibilities || []).map((e) => `${e.name} (${e.dateTaken})`).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Licenses:</span> ${(p.licenses || []).map((l) => `${l.name} (valid until ${l.validUntil})`).join(", ") || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Language Proficiency:</span> ${Object.keys(langProf).length ? Object.entries(langProf).map(([lang, ab]) => `${lang}: ${(ab as string[]).join("/")}`).join("; ") : "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">VII. Work Experience</h3>
      ${
        (p.workExperiences || []).length
          ? `<div class="space-y-2 text-sm">${p.workExperiences
              .map((w) => `<div class="border rounded-lg p-3" style="border-color:var(--color-border)"><div class="font-semibold">${w.position} &mdash; ${w.companyName}</div><div style="color:var(--color-muted)">${w.address} &middot; ${w.status} &middot; ${w.dateFrom} to ${w.dateTo}</div></div>`)
              .join("")}</div>`
          : `<div class="text-sm space-y-1"><div><span style="color:var(--color-muted)">Most Recent Company:</span> ${p.companyName || "&mdash;"}</div><div><span style="color:var(--color-muted)">Position:</span> ${p.position || "&mdash;"}</div><div><span style="color:var(--color-muted)">Summary:</span> ${p.experience || "&mdash;"}</div></div>`
      }
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">VIII. Requirements / Documents</h3>
      ${
        documents.length
          ? `<div class="space-y-2">${documents.map(documentPreviewRowHtml).join("")}</div>`
          : `<p class="text-sm" style="color:var(--color-muted)">${p.noDocumentsDeclared === "Yes" ? "Job Seeker declared they have no documents to submit." : "No documents uploaded."}</p>`
      }
    </div>
  `;
}
function seekerApplicationRow(a: Application & { vacancyTitle?: string; vacancyEmployer?: string }): string {
  const meta = STATUS_META[a.status] || STATUS_META.pending;
  return `
    <div class="card rounded-xl p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h4 class="font-semibold text-sm">${a.vacancyTitle || "Vacancy #" + a.vacancyId}</h4>
          <p class="text-xs" style="color:var(--color-muted)">${a.vacancyEmployer || ""} &middot; Applied ${a.dateApplied}</p>
        </div>
        <span class="status-pill ${meta.pill} flex-shrink-0">${meta.label}</span>
      </div>
    </div>`;
}

function seekerDetailCardHtml(d: { profile: AuthUser; documents: DocumentMeta[]; applications: (Application & { vacancyTitle?: string; vacancyEmployer?: string })[]; history: VerificationHistoryEntry[] }): string {
  const p = d.profile;
  return `
    <button onclick="staffBackFromSeekerDetail()" class="text-sm font-medium mb-4 inline-flex items-center gap-1" style="color:var(--color-primary)">&larr; Back to list</button>
    <h1 class="font-display text-2xl font-semibold mb-1">${p.name || p.email}</h1>
    <p class="text-sm mb-4" style="color:var(--color-muted)">${p.email}</p>
    ${verificationStatusCardHtml(p)}
    ${
      p.verificationStatus === "pending_verification"
        ? `<div class="flex gap-2 mb-6">
            <button onclick="staffVerifySeekerAction('${p.email}')" class="btn-primary text-sm font-semibold px-4 py-2 rounded-lg">Verify Profile</button>
            <button onclick="staffReturnSeekerAction('${p.email}')" class="text-sm font-semibold px-4 py-2 rounded-lg border" style="border-color:var(--color-border)">Return for Completion</button>
            <button onclick="staffRejectSeekerAction('${p.email}')" class="text-sm font-semibold px-4 py-2 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Reject</button>
          </div>`
        : ""
    }
    ${fullSeekerProfileSectionsHtml(p, d.documents)}
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">IX. Application Information</h3>
    <div class="space-y-3 mb-6 stagger-grid">${d.applications.map(seekerApplicationRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No applications yet.</p>`}</div>
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">X. Verification History</h3>
    ${historyTimelineHtml(d.history)}
  `;
}
/** Section 35: the complete Employer profile view, shared by Staff and Admin detail pages. */
function fullEmployerProfileSectionsHtml(p: AuthUser, documents: DocumentMeta[], employerVacancies: Vacancy[]): string {
  return `
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">I. Company / Employer Information</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Business Name:</span> ${p.employerBusinessName || p.employerCompanyName || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Trade Name:</span> ${p.employerTradeName || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Acronym:</span> ${p.employerAcronym || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">TIN:</span> ${p.employerTin || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Owner/President:</span> ${p.employerOwnerName || "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">II. Contact Information</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Contact Person:</span> ${p.employerContactPerson || "&mdash;"} ${p.employerPosition ? `(${p.employerPosition})` : ""}</div>
        <div><span style="color:var(--color-muted)">Mobile:</span> ${p.employerMobile || p.employerContactNumber || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Telephone:</span> ${p.employerTelephone || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Fax:</span> ${p.employerFax || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Email:</span> ${p.employerEmail || p.email}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">III. Business Information</h3>
      <div class="grid sm:grid-cols-2 gap-2 text-sm">
        <div><span style="color:var(--color-muted)">Employer Type:</span> ${p.employerType || "&mdash;"} ${p.employerCategory ? `(${p.employerCategory})` : ""}</div>
        <div><span style="color:var(--color-muted)">Nature of Work:</span> ${p.employerNatureOfWork || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Workforce Size:</span> ${p.employerWorkforceSize || "&mdash;"}</div>
        <div><span style="color:var(--color-muted)">Industry:</span> ${p.employerIndustry || "&mdash;"}</div>
        <div class="sm:col-span-2"><span style="color:var(--color-muted)">Description:</span> ${p.employerDescription || "&mdash;"}</div>
      </div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">IV. Address</h3>
      <div class="text-sm">${[p.employerStreet, p.employerBarangay, p.employerMunicipality, p.employerProvince].filter(Boolean).join(", ") || p.employerAddress || "&mdash;"}</div>
    </div>
    <div class="mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">V. Job Vacancies</h3>
      <div class="space-y-3 stagger-grid">${employerVacancies.map(staffVacancyApprovalRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No vacancies posted yet.</p>`}</div>
    </div>
    <div class="mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">VI. Job Requirements &amp; Qualifications</h3>
      <p class="text-sm" style="color:var(--color-muted)">Set per job vacancy &mdash; see Section V above for each posting's qualification requirements.</p>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">VII. Other Employer Information</h3>
      <div class="text-sm"><span style="color:var(--color-muted)">Establishment status:</span> ${VERIFICATION_STATUS_META[p.verificationStatus]?.label || p.verificationStatus}</div>
    </div>
    <div class="card rounded-xl p-5 mb-4">
      <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">VIII. Requirements / Documents</h3>
      ${
        documents.length
          ? `<div class="space-y-2">${documents.map(documentPreviewRowHtml).join("")}</div>`
          : `<p class="text-sm" style="color:var(--color-muted)">No documents uploaded.</p>`
      }
    </div>
  `;
}

function employerDetailCardHtml(d: { profile: AuthUser; vacancies: Vacancy[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] }): string {
  const p = d.profile;
  return `
    <button onclick="staffBackFromEmployerDetail()" class="text-sm font-medium mb-4 inline-flex items-center gap-1" style="color:var(--color-primary)">&larr; Back to list</button>
    <h1 class="font-display text-2xl font-semibold mb-1">${p.employerBusinessName || p.employerCompanyName || p.name}</h1>
    <p class="text-sm mb-4" style="color:var(--color-muted)">${p.email}</p>
    ${verificationStatusCardHtml(p)}
    ${
      p.verificationStatus === "pending_verification"
        ? `<div class="flex gap-2 mb-6">
            <button onclick="staffVerifyEmployerAction('${p.email}')" class="btn-primary text-sm font-semibold px-4 py-2 rounded-lg">Verify Profile</button>
            <button onclick="staffReturnEmployerAction('${p.email}')" class="text-sm font-semibold px-4 py-2 rounded-lg border" style="border-color:var(--color-border)">Return for Completion</button>
            <button onclick="staffRejectEmployerAction('${p.email}')" class="text-sm font-semibold px-4 py-2 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Reject</button>
          </div>`
        : ""
    }
    ${
      p.verificationStatus === "verified"
        ? `<div class="flex gap-2 mb-6"><button onclick="staffSuspendEmployerAction('${p.email}')" class="text-sm font-semibold px-4 py-2 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Suspend Establishment</button></div>`
        : ""
    }
    ${
      p.verificationStatus === "suspended"
        ? `<div class="flex gap-2 mb-6"><button onclick="staffReactivateEmployerAction('${p.email}')" class="btn-primary text-sm font-semibold px-4 py-2 rounded-lg">Reactivate Establishment</button></div>`
        : ""
    }
    ${fullEmployerProfileSectionsHtml(p, d.documents, d.vacancies)}
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">IX. Application Information</h3>
    <p class="text-sm mb-6" style="color:var(--color-muted)">See each vacancy's applicant list in Section V above.</p>
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">X. Verification History</h3>
    ${historyTimelineHtml(d.history)}
  `;
}

async function renderStaffDash(tab: string) {
  const content = $("dashContent");

  if (tab === "overview") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">PESO Staff Dashboard</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    let seekers: AuthUser[] = [], employers: AuthUser[] = [], vacs: Vacancy[] = [];
    try {
      [seekers, employers, vacs] = await Promise.all([api.staffGetSeekers("pending_verification"), api.staffGetEmployers("pending_verification"), api.staffGetVacancies("pending_approval")]);
    } catch {}
    if (currentUser?.role !== "staff" || currentDashTab !== "overview") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">PESO Staff Dashboard</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Review and verify Job Seeker and Employer profiles, and approve job vacancies.</p>
      <div class="grid sm:grid-cols-3 gap-4 mb-8 stagger-grid">
        <button onclick="dashTab('seekers')" class="card rounded-xl p-5 text-left hover:shadow-md"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${seekers.length}</div><div class="text-xs" style="color:var(--color-muted)">Job Seekers Pending Verification</div></button>
        <button onclick="dashTab('employers')" class="card rounded-xl p-5 text-left hover:shadow-md"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${employers.length}</div><div class="text-xs" style="color:var(--color-muted)">Employers Pending Verification</div></button>
        <button onclick="dashTab('vacancies')" class="card rounded-xl p-5 text-left hover:shadow-md"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${vacs.length}</div><div class="text-xs" style="color:var(--color-muted)">Vacancies Pending Approval</div></button>
      </div>
    `;
    return;
  }

  if (tab === "seekers") {
    if (staffSeekerDetailEmail && staffSeekerDetail) {
      content.innerHTML = seekerDetailCardHtml(staffSeekerDetail);
      return;
    }
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Job Seeker Verification</h1>
      <div class="flex items-center justify-between mb-4">
        <p class="text-sm" style="color:var(--color-muted)">Review submitted profiles and requirements.</p>
        ${statusFilterSelectHtml("staffSeekerFilterSelect", staffSeekerFilter, "staffFilterSeekers()")}
      </div>
      <div id="staffSeekersListBody" class="space-y-3 stagger-grid">Loading&hellip;</div>
    `;
    try {
      staffSeekersList = await api.staffGetSeekers(staffSeekerFilter || undefined);
    } catch {
      staffSeekersList = [];
    }
    if (currentUser?.role !== "staff" || currentDashTab !== "seekers") return;
    const body = document.getElementById("staffSeekersListBody");
    if (body) body.innerHTML = staffSeekersList.map(staffSeekerListRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No Job Seekers match this filter.</p>`;
    return;
  }

  if (tab === "employers") {
    if (staffEmployerDetailEmail && staffEmployerDetail) {
      content.innerHTML = employerDetailCardHtml(staffEmployerDetail);
      return;
    }
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Employer Verification</h1>
      <div class="flex items-center justify-between mb-4">
        <p class="text-sm" style="color:var(--color-muted)">Review employer accounts before they can post vacancies.</p>
        ${statusFilterSelectHtml("staffEmployerFilterSelect", staffEmployerFilter, "staffFilterEmployers()")}
      </div>
      <div id="staffEmployersListBody" class="space-y-3 stagger-grid">Loading&hellip;</div>
    `;
    try {
      staffEmployersList = await api.staffGetEmployers(staffEmployerFilter || undefined);
    } catch {
      staffEmployersList = [];
    }
    if (currentUser?.role !== "staff" || currentDashTab !== "employers") return;
    const body = document.getElementById("staffEmployersListBody");
    if (body) body.innerHTML = staffEmployersList.map(staffEmployerListRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No Employers match this filter.</p>`;
    return;
  }

  if (tab === "vacancies") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Vacancy Approvals</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      staffVacanciesList = await api.staffGetVacancies(staffVacancyFilter || undefined);
    } catch {
      staffVacanciesList = [];
    }
    if (currentUser?.role !== "staff" || currentDashTab !== "vacancies") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Vacancy Approvals</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Employer-submitted vacancies require approval before Job Seekers can see them.</p>
      <div class="space-y-3 stagger-grid">${staffVacanciesList.map(staffVacancyApprovalRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No vacancies pending approval.</p>`}</div>
    `;
    return;
  }

  if (tab === "refer") {
    await renderReferSeekerTab(content);
    return;
  }

  if (tab === "applications") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Application Monitoring</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      staffApplicationsList = await api.staffGetApplications();
    } catch {
      staffApplicationsList = [];
    }
    if (currentUser?.role !== "staff" || currentDashTab !== "applications") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Application Monitoring</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Job Seekers apply directly to Employers. This is a read-only view for monitoring &mdash; the Employer decides whether to accept or reject each applicant.</p>
      <div class="space-y-3 stagger-grid">${staffApplicationsList.map(staffApplicationRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No applications yet.</p>`}</div>
    `;
    return;
  }
}

/** Section 3: Refer Seeker tab — Staff picks an approved vacancy, then sees only the
 * Verified Job Seekers whose Match Score already clears the referral threshold for it. */
async function renderReferSeekerTab(content: HTMLElement) {
  content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Refer Seeker</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
  try {
    referApprovedVacancies = await api.staffGetVacancies("approved");
  } catch {
    referApprovedVacancies = [];
  }
  if (currentUser?.role !== "staff" || currentDashTab !== "refer") return;
  if (referSelectedVacancyId && !referApprovedVacancies.some((v) => v.id === referSelectedVacancyId)) {
    referSelectedVacancyId = null;
    referCandidates = [];
  }
  renderReferSeekerBody();
  if (referSelectedVacancyId) loadReferCandidates(referSelectedVacancyId);
}

function renderReferSeekerBody() {
  const content = $("dashContent");
  content.innerHTML = `
    <h1 class="font-display text-2xl font-semibold mb-1">Refer Seeker</h1>
    <p class="text-sm mb-4" style="color:var(--color-muted)">Select an approved job vacancy to see which verified Job Seekers already meet its requirements (Match Score of ${MATCH_DISPLAY_THRESHOLD}% or higher), then send a job invitation. The seeker will review the vacancy before choosing to apply.</p>
    <div class="card rounded-xl p-5 mb-5">
      <label for="referVacancySelect" class="text-xs font-semibold block mb-1.5">Job Vacancy</label>
      <select id="referVacancySelect" onchange="referVacancyChanged()" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)">
        <option value="">Select an approved vacancy&hellip;</option>
        ${referApprovedVacancies.map((v) => `<option value="${v.id}" ${referSelectedVacancyId === v.id ? "selected" : ""}>${v.title} &mdash; ${v.employer}</option>`).join("")}
      </select>
      ${referApprovedVacancies.length === 0 ? `<p class="text-xs mt-2" style="color:var(--color-muted)">No approved vacancies yet &mdash; approve one under Vacancy Approvals first.</p>` : ""}
    </div>
    <div id="referCandidatesBody">${referSelectedVacancyId ? `<p class="text-sm" style="color:var(--color-muted)">Loading matching Job Seekers&hellip;</p>` : ""}</div>
  `;
}

function referVacancyChanged() {
  const val = ($("referVacancySelect") as HTMLSelectElement).value;
  referSelectedVacancyId = val ? Number(val) : null;
  referCandidates = [];
  const body = document.getElementById("referCandidatesBody");
  if (!referSelectedVacancyId) {
    if (body) body.innerHTML = "";
    return;
  }
  if (body) body.innerHTML = `<p class="text-sm" style="color:var(--color-muted)">Loading matching Job Seekers&hellip;</p>`;
  loadReferCandidates(referSelectedVacancyId);
}

async function loadReferCandidates(vacancyId: number) {
  try {
    const data = await api.staffGetReferralCandidates(vacancyId);
    referCandidates = data.candidates;
  } catch (err) {
    referCandidates = [];
    showToast(errMsg(err, "Could not load matching Job Seekers."));
  }
  if (currentUser?.role !== "staff" || currentDashTab !== "refer" || referSelectedVacancyId !== vacancyId) return;
  const body = document.getElementById("referCandidatesBody");
  if (!body) return;
  if (referCandidates.length === 0) {
    body.innerHTML = `<p class="text-sm" style="color:var(--color-muted)">No verified Job Seekers currently meet this vacancy's requirements (${MATCH_DISPLAY_THRESHOLD}%+ match). Check back once more Job Seekers are verified or update their profiles.</p>`;
    return;
  }
  body.innerHTML = `<div class="space-y-3 stagger-grid">${referCandidates.map(referCandidateRowHtml).join("")}</div>`;
}

function referCandidateRowHtml(c: api.ReferralCandidate): string {
  const tier = matchTier(c.matchScore);
  return `
    <div class="card rounded-xl p-5">
      <div class="flex items-start justify-between gap-3 mb-2">
        <div>
          <h4 class="font-semibold text-sm">${c.name}</h4>
          <p class="text-xs" style="color:var(--color-muted)">${c.email}</p>
        </div>
        <span class="match-pill match-${tier} text-sm flex-shrink-0">${c.matchScore}% Match</span>
      </div>
      <div class="grid sm:grid-cols-3 gap-2 text-xs mb-3" style="color:var(--color-muted)">
        <div>Education: <strong style="color:var(--color-text)">${c.matchBreakdown.educationScore}%</strong></div>
        <div>Skills: <strong style="color:var(--color-text)">${c.matchBreakdown.skillsScore}%</strong></div>
        <div>Experience: <strong style="color:var(--color-text)">${c.matchBreakdown.experienceScore}%</strong></div>
      </div>
      <button onclick="referSeekerAction('${c.email}')" class="btn-primary text-xs font-semibold px-4 py-2 rounded-lg" ${referBusy ? "disabled" : ""}>Send Job Invitation</button>
    </div>`;
}

async function referSeekerAction(email: string) {
  if (!referSelectedVacancyId || referBusy) return;
  referBusy = true;
  try {
    await api.staffReferSeeker(email, referSelectedVacancyId);
    showToast("Job invitation sent. The seeker can review the vacancy before deciding to apply.");
    referCandidates = referCandidates.filter((c) => c.email !== email);
    const body = document.getElementById("referCandidatesBody");
    if (body) {
      body.innerHTML = referCandidates.length
        ? `<div class="space-y-3 stagger-grid">${referCandidates.map(referCandidateRowHtml).join("")}</div>`
        : `<p class="text-sm" style="color:var(--color-muted)">All currently matching Job Seekers for this vacancy have been referred.</p>`;
    }
  } catch (err) {
    showToast(errMsg(err, "Could not refer this Job Seeker."));
  } finally {
    referBusy = false;
  }
}


let adminSeekersList: (AuthUser & { profileComplete: boolean; applicationCount: number; documentCount: number })[] = [];
let adminEmployersList: (AuthUser & { vacancyCount: number })[] = [];
// Section 24/25: the Admin's main list should default to Staff-VERIFIED profiles only,
// with Pending/Incomplete kept in separate filterable buckets so the dashboard doesn't
// get cluttered with not-yet-reviewed accounts.
let adminSeekerFilter = "verified";
let adminEmployerFilter = "verified";
function adminFilterSeekers() {
  adminSeekerFilter = ($("adminSeekerFilterSelect") as HTMLSelectElement).value;
  dashTabInner("seekers");
}
function adminFilterEmployers() {
  adminEmployerFilter = ($("adminEmployerFilterSelect") as HTMLSelectElement).value;
  dashTabInner("employers");
}
let adminStaffList: AuthUser[] = [];
let adminAdminsList: AuthUser[] = [];
let adminActivityList: ActivityLogEntry[] = [];
let adminReportDate = new Date().toISOString().slice(0, 10);
let adminReportMonth = adminReportDate.slice(0, 7);
let adminDailyReport: api.AdminDailyReport | null = null;
/** Same independent-state fix as Staff (see staffSeekerDetailEmail/staffEmployerDetailEmail
 * above): the Seekers tab and Employers tab each keep their own "drilled into a detail
 * view" state, so switching between them and back no longer drops you back to the list. */
let adminSeekerDetailEmail: string | null = null;
let adminEmployerDetailEmail: string | null = null;
let adminSeekerDetail: { profile: AuthUser; applications: (Application & { vacancyTitle?: string; vacancyEmployer?: string })[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] } | null = null;
let adminEmployerDetail: { profile: AuthUser; vacancies: Vacancy[]; applications: any[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] } | null = null;
/** Section 4: when Admin opens a Seeker's profile FROM inside an Employer's "IX.
 * Application Information" list, remember which Employer to return to so "Back"
 * lands on that exact Employer page again, not the generic Seekers list. */
let adminSeekerDetailReturnToEmployer: string | null = null;
let adminSeekerDetailReturnToInventory = false;
let adminInventoryVacancies: Vacancy[] = [];
let adminInventoryApplications: (Application & { seekerEmail: string; seekerName: string; seekerContact?: string; vacancyTitle: string; vacancyEmployer: string })[] = [];

function escapeReportHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function reportDateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "full", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00.000Z`));
}

function adminReportCalendarHtml(): string {
  const [year, month] = adminReportMonth.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthLabel = new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  const blanks = Array.from({ length: firstDay }, () => `<span class="report-calendar-empty" aria-hidden="true"></span>`).join("");
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = `${adminReportMonth}-${String(day).padStart(2, "0")}`;
    const hasData = Boolean(adminDailyReport?.datesWithData[date]);
    return `<button type="button" class="report-calendar-day${date === adminReportDate ? " selected" : ""}${hasData ? " has-data" : ""}" onclick="adminSelectReportDate('${date}')" aria-label="${escapeReportHtml(reportDateLabel(date))}${hasData ? ", report data available" : ""}" aria-pressed="${date === adminReportDate}">
      <span>${day}</span>${hasData ? `<i aria-hidden="true"></i>` : ""}
    </button>`;
  }).join("");
  const cellCount = firstDay + daysInMonth;
  const trailing = cellCount % 7 ? 7 - (cellCount % 7) : 0;
  const blanksAfter = Array.from({ length: trailing }, () => `<span class="report-calendar-empty" aria-hidden="true"></span>`).join("");
  return `<div class="report-calendar">
    <div class="report-calendar-header">
      <button type="button" onclick="adminChangeReportMonth(-1)" aria-label="Previous month" class="report-calendar-nav">&lsaquo;</button>
      <strong>${escapeReportHtml(monthLabel)}</strong>
      <button type="button" onclick="adminChangeReportMonth(1)" aria-label="Next month" class="report-calendar-nav">&rsaquo;</button>
    </div>
    <div class="report-calendar-grid report-calendar-weekdays" aria-hidden="true">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="report-calendar-grid">${blanks}${days}${blanksAfter}</div>
    <div class="report-calendar-footer"><span><i></i> Dates with report records</span><button type="button" class="report-today" onclick="adminSelectReportDate('${new Date().toISOString().slice(0, 10)}')">Today</button></div>
  </div>`;
}

function adminSelectReportDate(date: string) {
  adminReportDate = date;
  adminReportMonth = date.slice(0, 7);
  void renderAdminReports();
}

function adminChangeReportMonth(amount: number) {
  const [year, month] = adminReportMonth.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1 + amount, 1));
  adminReportMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  const selectedDay = Number(adminReportDate.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  adminReportDate = `${adminReportMonth}-${String(Math.min(selectedDay, daysInMonth)).padStart(2, "0")}`;
  void renderAdminReports();
}

function adminDailyReportTables(report: api.AdminDailyReport): string {
  const vacancyRows = report.vacancies.map((vacancy) => `<tr>
    <td>${escapeReportHtml(vacancy.title || "—")}</td><td>${escapeReportHtml(vacancy.employer || "—")}</td>
    <td>${escapeReportHtml(vacancy.location || "—")}</td><td>${escapeReportHtml(vacancy.slots)}</td>
    <td>${escapeReportHtml(vacancy.posted || "—")}</td><td>${escapeReportHtml(vacancy.status.replace(/_/g, " ") || "—")}</td>
  </tr>`).join("");
  const seekerRows = report.seekers.map((seeker) => `<tr>
    <td>${escapeReportHtml(seeker.name || "—")}</td><td>${escapeReportHtml(seeker.registeredAt || "—")}</td>
    <td>${escapeReportHtml(seeker.educationLevel || "—")}</td><td>${escapeReportHtml(seeker.skills || "—")}</td>
    <td>${escapeReportHtml(seeker.verificationStatus.replace(/_/g, " ") || "—")}</td>
  </tr>`).join("");
  return `
    <section class="card rounded-xl p-4 sm:p-5 report-section">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div><h2 class="font-semibold text-base">Job Vacancy Report</h2><p class="text-xs mt-1" style="color:var(--color-muted)">${report.vacancies.length} vacancy record(s)</p></div>
        <button type="button" class="btn-outline text-xs font-semibold px-3 py-2 rounded-lg" onclick="downloadAdminDailyReport('vacancies')">Download Vacancy Report (PDF)</button>
      </div>
      <div class="report-table-scroll"><table class="report-table"><thead><tr><th>Job title</th><th>Employer / company</th><th>Location</th><th>Positions</th><th>Date posted</th><th>Status</th></tr></thead>
      <tbody>${vacancyRows || `<tr><td class="report-empty" colspan="6">No job vacancies found for this date.</td></tr>`}</tbody></table></div>
    </section>
    <section class="card rounded-xl p-4 sm:p-5 report-section">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div><h2 class="font-semibold text-base">Job Seeker Report</h2><p class="text-xs mt-1" style="color:var(--color-muted)">${report.seekers.length} newly registered job seeker(s)</p></div>
        <button type="button" class="btn-outline text-xs font-semibold px-3 py-2 rounded-lg" onclick="downloadAdminDailyReport('seekers')">Download Job Seeker Report (PDF)</button>
      </div>
      <div class="report-table-scroll"><table class="report-table"><thead><tr><th>Job seeker</th><th>Registered</th><th>Education</th><th>Skills / qualifications</th><th>Verification</th></tr></thead>
      <tbody>${seekerRows || `<tr><td class="report-empty" colspan="5">No job seekers registered on this date.</td></tr>`}</tbody></table></div>
    </section>
    <div class="flex justify-end"><button type="button" class="btn-primary text-sm font-semibold px-4 py-2.5 rounded-lg" onclick="downloadAdminDailyReport('complete')">Download Complete Daily Report (PDF)</button></div>`;
}

async function renderAdminReports(): Promise<void> {
  const content = $("dashContent");
  const requestDate = adminReportDate;
  const requestMonth = adminReportMonth;
  content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Reports</h1><p class="text-sm mb-5" style="color:var(--color-muted)">Select a day to view the vacancies posted and job seekers registered on that date.</p><div class="card rounded-xl p-5"><p class="text-sm" role="status">Loading report data&hellip;</p></div>`;
  try {
    const report = await api.adminGetDailyReport(requestDate, requestMonth);
    if (currentUser?.role !== "admin" || currentDashTab !== "reports" || adminReportDate !== requestDate || adminReportMonth !== requestMonth) return;
    adminDailyReport = report;
    content.innerHTML = `
      <div class="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div><h1 class="font-display text-2xl font-semibold mb-1">Reports</h1><p class="text-sm" style="color:var(--color-muted)">Daily vacancy and job seeker registration reports.</p></div>
      </div>
      <div class="grid lg:grid-cols-[minmax(260px,340px)_1fr] gap-5 items-start mb-5">
        <section class="card rounded-xl p-4 sm:p-5" aria-label="Report date calendar">
          ${adminReportCalendarHtml()}
        </section>
        <div>
          <p class="text-xs font-semibold uppercase tracking-wide mb-2" style="color:var(--color-muted)">Selected date</p>
          <h2 class="font-display text-xl sm:text-2xl font-semibold mb-4">${escapeReportHtml(reportDateLabel(report.date))}</h2>
          <div class="grid sm:grid-cols-2 gap-3">
            <div class="card rounded-xl p-4"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${report.vacancies.length}</div><div class="text-xs" style="color:var(--color-muted)">Job Vacancies</div></div>
            <div class="card rounded-xl p-4"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${report.seekers.length}</div><div class="text-xs" style="color:var(--color-muted)">New Job Seekers</div></div>
          </div>
        </div>
      </div>
      <div class="space-y-5">${adminDailyReportTables(report)}</div>`;
  } catch (error) {
    if (currentUser?.role !== "admin" || currentDashTab !== "reports" || adminReportDate !== requestDate || adminReportMonth !== requestMonth) return;
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Reports</h1><p class="text-sm mb-5" style="color:var(--color-muted)">Select a day to view the daily records.</p><div class="card rounded-xl p-5"><p class="text-sm mb-3" style="color:var(--color-accent-dark)" role="alert">${escapeReportHtml(errMsg(error, "Could not load the report data."))}</p><button class="btn-primary text-sm font-semibold px-3 py-2 rounded-lg" onclick="renderAdminReports()">Try again</button></div>`;
  }
}

async function downloadAdminDailyReport(type: "vacancies" | "seekers" | "complete"): Promise<void> {
  const date = adminReportDate;
  try {
    const pdf = await api.adminDownloadDailyReport(type, date);
    const url = URL.createObjectURL(pdf);
    const prefix = type === "vacancies" ? "Vacancy_Report" : type === "seekers" ? "Job_Seeker_Report" : "Complete_Daily_Report";
    const link = document.createElement("a");
    link.href = url;
    link.download = `${prefix}_${date}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    showToast(errMsg(error, "Could not download the PDF report."));
  }
}

async function adminOpenSeekerDetail(email: string) {
  adminSeekerDetailEmail = email;
  adminSeekerDetailReturnToEmployer = null;
  adminSeekerDetailReturnToInventory = false;
  try {
    adminSeekerDetail = await api.adminGetSeeker(email);
  } catch (err) {
    showToast(errMsg(err, "Could not load this profile."));
    return;
  }
  dashTabInner("seekers");
}
/** Section 4: "View Profile" from an Employer's Application Information list — always
 * navigates to the exact Seeker selected (never a generic or the Admin's own profile),
 * and remembers to return to this Employer's page afterward. Deliberately leaves the
 * Employer detail state untouched so it's still there when you come back. */
async function adminViewApplicantSeekerProfile(seekerEmail: string) {
  const returnToEmployer = adminEmployerDetailEmail;
  adminSeekerDetailEmail = seekerEmail;
  adminSeekerDetailReturnToInventory = false;
  try {
    adminSeekerDetail = await api.adminGetSeeker(seekerEmail);
  } catch (err) {
    showToast(errMsg(err, "Could not load this seeker's profile."));
    adminSeekerDetailEmail = null;
    return;
  }
  adminSeekerDetailReturnToEmployer = returnToEmployer;
  dashTabInner("seekers");
}
async function adminViewInventorySeekerProfile(seekerEmail: string) {
  closeVacancyDetailModal();
  adminSeekerDetailEmail = seekerEmail;
  adminSeekerDetailReturnToEmployer = null;
  adminSeekerDetailReturnToInventory = true;
  try {
    adminSeekerDetail = await api.adminGetSeeker(seekerEmail);
  } catch (err) {
    showToast(errMsg(err, "Could not load this seeker's profile."));
    adminSeekerDetailEmail = null;
    adminSeekerDetailReturnToInventory = false;
    return;
  }
  dashTabInner("seekers");
}
async function adminOpenEmployerDetail(email: string) {
  adminEmployerDetailEmail = email;
  try {
    adminEmployerDetail = await api.adminGetEmployer(email);
  } catch (err) {
    showToast(errMsg(err, "Could not load this profile."));
    return;
  }
  dashTabInner("employers");
}
async function adminBackFromSeekerDetail() {
  const returnToEmployer = adminSeekerDetailReturnToEmployer;
  const returnToInventory = adminSeekerDetailReturnToInventory;
  adminSeekerDetailEmail = null;
  adminSeekerDetail = null;
  adminSeekerDetailReturnToEmployer = null;
  adminSeekerDetailReturnToInventory = false;
  if (returnToInventory) {
    dashTabInner("vacancyInventory");
    return;
  }
  if (returnToEmployer) {
    if (adminEmployerDetailEmail === returnToEmployer && adminEmployerDetail) {
      dashTabInner("employers");
    } else {
      await adminOpenEmployerDetail(returnToEmployer);
    }
    return;
  }
  dashTabInner("seekers");
}
function adminBackFromEmployerDetail() {
  if (adminSeekerDetailReturnToEmployer === adminEmployerDetailEmail) adminSeekerDetailReturnToEmployer = null;
  adminEmployerDetailEmail = null;
  adminEmployerDetail = null;
  dashTabInner("employers");
}

async function adminDeleteSeekerAction(email: string) {
  if (!window.confirm(`Permanently delete the job seeker account for ${email}? Their applications, documents, and account data will also be deleted.`)) return;
  try {
    await api.adminDeleteSeeker(email);
    if (adminSeekerDetailEmail === email) {
      adminSeekerDetailEmail = null;
      adminSeekerDetail = null;
      adminSeekerDetailReturnToEmployer = null;
      adminSeekerDetailReturnToInventory = false;
    }
    showToast("Job seeker account deleted.");
    await renderAdminDash("seekers");
  } catch (err) {
    showToast(errMsg(err, "Could not delete this job seeker."));
  }
}

async function adminDeleteEmployerAction(email: string) {
  if (!window.confirm(`Permanently delete the employer account for ${email}, all of its vacancies, and all applications to those vacancies?`)) return;
  try {
    await api.adminDeleteEmployer(email);
    if (adminEmployerDetailEmail === email) {
      adminEmployerDetailEmail = null;
      adminEmployerDetail = null;
    }
    showToast("Employer account and related vacancies deleted.");
    await renderAdminDash("employers");
  } catch (err) {
    showToast(errMsg(err, "Could not delete this employer."));
  }
}

async function adminDeleteVacancyAction(id: number) {
  const vacancy = adminInventoryVacancies.find((item) => item.id === id);
  const label = vacancy?.title || `vacancy #${id}`;
  if (!window.confirm(`Permanently delete "${label}" and all applications for this vacancy?`)) return;
  try {
    await api.adminDeleteVacancy(id);
    closeVacancyDetailModal();
    showToast("Vacancy and its applications deleted.");
    await renderAdminDash("vacancyInventory");
  } catch (err) {
    showToast(errMsg(err, "Could not delete this vacancy."));
  }
}

async function adminDeleteApplicationAction(id: number) {
  if (!window.confirm("Permanently delete this application and its status history?")) return;
  try {
    await api.adminDeleteApplication(id);
    showToast("Application deleted.");
    await renderAdminDash("applications");
  } catch (err) {
    showToast(errMsg(err, "Could not delete this application."));
  }
}

function adminSeekerListRow(s: AuthUser & { profileComplete: boolean; applicationCount: number; documentCount: number }): string {
  const meta = VERIFICATION_STATUS_META[s.verificationStatus] || VERIFICATION_STATUS_META.draft;
  return `
    <div class="card rounded-xl p-4 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-sm truncate">${s.name || s.email}</div>
        <div class="text-xs truncate" style="color:var(--color-muted)">${s.email} &middot; ${s.applicationCount} application(s) &middot; ${s.documentCount} doc(s)</div>
        ${s.verificationStatus === "draft" ? registrationExpiryTimerHtml(s.registrationExpiresAt) : ""}
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full" style="background:${meta.bg}; color:${meta.fg}">${meta.label}</span>
        <button onclick="adminOpenSeekerDetail('${s.email}')" class="btn-outline text-xs font-semibold px-3 py-1.5 rounded-lg">View</button>
        <button onclick="adminDeleteSeekerAction('${s.email}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Delete</button>
      </div>
    </div>`;
}
function adminEmployerListRow(e: AuthUser & { vacancyCount: number }): string {
  const meta = VERIFICATION_STATUS_META[e.verificationStatus] || VERIFICATION_STATUS_META.draft;
  return `
    <div class="card rounded-xl p-4 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-sm truncate">${e.employerBusinessName || e.employerCompanyName || e.name || e.email}</div>
        <div class="text-xs truncate" style="color:var(--color-muted)">${e.email} &middot; ${e.vacancyCount} vacanc${e.vacancyCount === 1 ? "y" : "ies"}</div>
        ${e.verificationStatus === "draft" ? registrationExpiryTimerHtml(e.registrationExpiresAt) : ""}
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full" style="background:${meta.bg}; color:${meta.fg}">${meta.label}</span>
        <button onclick="adminOpenEmployerDetail('${e.email}')" class="btn-outline text-xs font-semibold px-3 py-1.5 rounded-lg">View</button>
        <button onclick="adminDeleteEmployerAction('${e.email}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Delete</button>
      </div>
    </div>`;
}

function adminVacancyInventoryCardHtml(
  vacancy: Vacancy,
): string {
  return `
    <article class="card rounded-xl p-4 flex items-center justify-between gap-3">
      <h2 class="font-semibold text-base min-w-0">${vacancy.title || "(untitled vacancy)"}</h2>
      <button onclick="adminOpenVacancyInventoryDetails(${vacancy.id})" class="btn-outline text-xs font-semibold px-4 py-2 rounded-lg flex-shrink-0">View Details</button>
    </article>`;
}

function adminVacancyInventoryDetailsHtml(
  vacancy: Vacancy,
  applications: (Application & { seekerEmail: string; seekerName: string; vacancyTitle: string; vacancyEmployer: string })[],
): string {
  const hired = applications.filter((application) =>
    application.status === "hired" || application.employerStatus === "accepted_hired",
  );
  return `
    <div class="mb-4 flex items-center gap-2">
      <span class="text-xs font-semibold px-2.5 py-1 rounded-full" style="background:${(VACANCY_STATUS_META[vacancy.status] || VACANCY_STATUS_META.pending_approval).bg}; color:${(VACANCY_STATUS_META[vacancy.status] || VACANCY_STATUS_META.pending_approval).fg}">${(VACANCY_STATUS_META[vacancy.status] || VACANCY_STATUS_META.pending_approval).label}</span>
      <span class="text-xs" style="color:var(--color-muted)">${vacancy.employer} &middot; ${vacancy.employerEmail || "Demo vacancy"}</span>
    </div>
    <div class="grid sm:grid-cols-2 gap-2 text-sm mb-4">
      <div><strong>Location:</strong> ${vacancy.location || "&mdash;"}</div>
      <div><strong>Category:</strong> ${vacancy.category || "&mdash;"}</div>
      <div><strong>Work type:</strong> ${vacancy.type || "&mdash;"}</div>
      <div><strong>Salary:</strong> ${vacancy.salary || "&mdash;"}</div>
      <div><strong>Slots:</strong> ${vacancy.slots}</div>
      <div><strong>Expiry period:</strong> ${vacancy.expiryDays ?? 5} days</div>
      <div><strong>Valid through:</strong> ${vacancy.validUntil || "Not set"}</div>
      <div><strong>Minimum education:</strong> ${vacancy.minEducationLevel || "&mdash;"}</div>
      <div><strong>Minimum experience:</strong> ${vacancy.minExperienceYears} year(s)</div>
      <div><strong>Required skills:</strong> ${vacancy.requiredSkills.join(", ") || "&mdash;"}</div>
      <div><strong>Work experience:</strong> ${vacancy.workExperience || "&mdash;"}</div>
    </div>
    <div class="flex justify-end mb-4">
    <button onclick="adminDeleteVacancyAction(${vacancy.id})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Delete Vacancy</button>
    </div>
    <p class="text-sm whitespace-pre-line mb-4">${vacancy.description || "No job description provided."}</p>
    ${vacancy.qualification.length ? `<div class="mb-3"><strong class="text-xs">Qualifications</strong><ul class="text-xs list-disc pl-5 mt-1">${vacancy.qualification.map((qualification) => `<li>${qualification}</li>`).join("")}</ul></div>` : ""}
    ${vacancy.otherQualifications ? `<p class="text-xs mb-3"><strong>Other qualifications:</strong> ${vacancy.otherQualifications}</p>` : ""}
    <p class="text-xs mb-3" style="color:var(--color-muted)">${applications.length} applicant(s) &middot; ${hired.length} hired</p>
    <h3 class="font-semibold text-sm mb-2">Hired job seeker${hired.length === 1 ? "" : "s"}</h3>
      ${hired.length
        ? `<div class="space-y-2">${hired.map((application) => `
          <div class="rounded-lg border p-3 flex items-center justify-between gap-3" style="border-color:var(--color-border)">
            <div class="min-w-0">
              <div class="font-semibold text-sm">${application.seekerName}</div>
              <div class="text-xs" style="color:var(--color-muted)">${application.seekerEmail} &middot; Applied ${application.dateApplied}</div>
            </div>
            <button onclick="adminViewInventorySeekerProfile('${application.seekerEmail}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border flex-shrink-0" style="border-color:var(--color-primary); color:var(--color-primary)">View full profile</button>
          </div>`).join("")}</div>`
        : `<p class="text-xs" style="color:var(--color-muted)">No applicant has been marked as hired for this vacancy yet.</p>`}
  `;
}

function adminOpenVacancyInventoryDetails(id: number) {
  const vacancy = adminInventoryVacancies.find((item) => item.id === id);
  const overlay = $("vacancyDetailOverlay");
  const title = $("vacancyDetailModalTitle");
  const body = $("vacancyDetailModalBody");
  if (!vacancy) {
    body.innerHTML = `<p class="text-sm p-8" style="color:#C0392B">Could not find this vacancy.</p>`;
    overlay.classList.remove("hidden");
    return;
  }
  title.textContent = vacancy.title || "Vacancy Details";
  body.innerHTML = adminVacancyInventoryDetailsHtml(
    vacancy,
    adminInventoryApplications.filter((application) => application.vacancyId === vacancy.id),
  );
  overlay.classList.remove("hidden");
  const mapCoordinates = validMapCoordinates(vacancy.latitude, vacancy.longitude);
  if (mapCoordinates) {
    requestAnimationFrame(() => mountLocationMap(`staffVacancyMap-${vacancy.id}`, mapCoordinates));
  }
}

let editingStaffEmail: string | null = null;
function staffAccountRowHtml(s: AuthUser): string {
  if (editingStaffEmail === s.email) {
    return `
      <div class="card rounded-xl p-4">
        <div class="grid sm:grid-cols-3 gap-3 items-end mb-2">
          <div><label for="editStaffName" class="text-xs font-semibold block mb-1.5">Full Name</label><input id="editStaffName" value="${s.name}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          <div><label for="editStaffEmail" class="text-xs font-semibold block mb-1.5">Email (fixed)</label><input id="editStaffEmail" value="${s.email}" disabled class="w-full border rounded-lg px-3 py-2 text-sm opacity-60" style="border-color:var(--color-border)"></div>
          <div>${passwordFieldHtml("editStaffPassword", "New Password (optional)", { minlength: 6, placeholder: "Leave blank to keep current" })}</div>
        </div>
        <div class="flex gap-2">
          <button onclick="saveStaffEdit('${s.email}')" class="btn-primary text-xs font-semibold px-3 py-1.5 rounded-lg">Save Changes</button>
          <button onclick="cancelStaffEdit()" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border)">Cancel</button>
        </div>
      </div>`;
  }
  return `
    <div class="card rounded-xl p-4 flex items-center justify-between gap-3">
      <div>
        <div class="font-semibold text-sm">${s.name}</div>
        <div class="text-xs" style="color:var(--color-muted)">${s.email}</div>
      </div>
      <div class="flex gap-2 flex-shrink-0">
        <button onclick="startStaffEdit('${s.email}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border)">Edit</button>
        <button onclick="deleteStaffAccount('${s.email}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Delete</button>
      </div>
    </div>`;
}

/** Admin Accounts (this request): same edit-in-place pattern as Staff Accounts
 * above, extended so an Admin can also edit their OWN account (name/password) —
 * self-deletion is blocked server-side instead, since that's the one action that
 * can't be sensibly undone from inside the dashboard. */
let editingAdminEmail: string | null = null;
function adminAccountRowHtml(a: AuthUser): string {
  const isSelf = a.email === currentUser?.email;
  if (editingAdminEmail === a.email) {
    return `
      <div class="card rounded-xl p-4">
        <div class="grid sm:grid-cols-3 gap-3 items-end mb-2">
          <div><label for="editAdminName" class="text-xs font-semibold block mb-1.5">Full Name</label><input id="editAdminName" value="${a.name}" class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          <div><label for="editAdminEmail" class="text-xs font-semibold block mb-1.5">Username/Email (fixed)</label><input id="editAdminEmail" value="${a.email}" disabled class="w-full border rounded-lg px-3 py-2 text-sm opacity-60" style="border-color:var(--color-border)"></div>
          <div>${passwordFieldHtml("editAdminPassword", "New Password (optional)", { minlength: 6, placeholder: "Leave blank to keep current" })}</div>
        </div>
        ${isSelf ? `<p class="text-xs mb-2" style="color:#8A5A0F">This is your own account. Changing the password will sign you out immediately.</p>` : ""}
        <div class="flex gap-2">
          <button onclick="saveAdminEdit('${a.email}')" class="btn-primary text-xs font-semibold px-3 py-1.5 rounded-lg">Save Changes</button>
          <button onclick="cancelAdminEdit()" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border)">Cancel</button>
        </div>
      </div>`;
  }
  return `
    <div class="card rounded-xl p-4 flex items-center justify-between gap-3">
      <div>
        <div class="font-semibold text-sm">${a.name} ${isSelf ? `<span class="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ml-1" style="background:#DCEAF7; color:#1D5A85">You</span>` : ""}</div>
        <div class="text-xs" style="color:var(--color-muted)">${a.email}</div>
      </div>
      <div class="flex gap-2 flex-shrink-0">
        <button onclick="startAdminEdit('${a.email}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:var(--color-border)">Edit</button>
        ${isSelf ? "" : `<button onclick="deleteAdminAccount('${a.email}')" class="text-xs font-semibold px-3 py-1.5 rounded-lg border" style="border-color:#C0392B; color:#C0392B">Delete</button>`}
      </div>
    </div>`;
}
function startStaffEdit(email: string) {
  editingStaffEmail = email;
  dashTabInner("staffmgmt");
}
function cancelStaffEdit() {
  editingStaffEmail = null;
  dashTabInner("staffmgmt");
}
async function saveStaffEdit(email: string) {
  const name = $<HTMLInputElement>("editStaffName").value.trim();
  const password = $<HTMLInputElement>("editStaffPassword").value;
  if (!name) {
    showToast("Name is required.");
    return;
  }
  try {
    await api.adminUpdateStaff(email, name, password || undefined);
    showToast(password ? "Staff account updated — their sessions were signed out for security." : "Staff account updated.");
    editingStaffEmail = null;
    dashTabInner("staffmgmt");
  } catch (err) {
    showToast(errMsg(err, "Could not update this staff account."));
  }
}
async function deleteStaffAccount(email: string) {
  if (!window.confirm(`Delete the staff account for ${email}? This can't be undone.`)) return;
  try {
    await api.adminDeleteStaff(email);
    showToast("Staff account deleted.");
    dashTabInner("staffmgmt");
  } catch (err) {
    showToast(errMsg(err, "Could not delete this staff account."));
  }
}

async function adminCreateStaffAccount(e: Event): Promise<boolean> {
  e.preventDefault();
  const name = $<HTMLInputElement>("asName").value;
  const email = $<HTMLInputElement>("asEmail").value;
  const password = $<HTMLInputElement>("asPassword").value;
  try {
    await api.adminCreateStaff(name, email, password);
    showToast("Staff account created.");
    dashTabInner("staffmgmt");
  } catch (err) {
    showToast(errMsg(err, "Could not create staff account."));
  }
  return false;
}

/* ---- Admin Accounts: same actions as Staff Accounts above, plus special
 * handling for editing your OWN account's password, which signs you out. ---- */
function startAdminEdit(email: string) {
  editingAdminEmail = email;
  dashTabInner("adminmgmt");
}
function cancelAdminEdit() {
  editingAdminEmail = null;
  dashTabInner("adminmgmt");
}
async function saveAdminEdit(email: string) {
  const name = $<HTMLInputElement>("editAdminName").value.trim();
  const password = $<HTMLInputElement>("editAdminPassword").value;
  if (!name) {
    showToast("Name is required.");
    return;
  }
  try {
    const { selfPasswordChanged } = await api.adminUpdateAdmin(email, name, password || undefined);
    editingAdminEmail = null;
    if (selfPasswordChanged) {
      // The server already invalidated this session along with every other session
      // on the account, so the current login token is dead — clear it locally too
      // and send them back to Login to sign in again with the new password.
      await api.logout().catch(() => {});
      currentUser = null;
      applications = [];
      notifications = [];
      documents = [];
      showToast("Password updated. Please log in again with your new password.");
      navInner("login");
      return;
    }
    showToast(password ? "Admin account updated — their sessions were signed out for security." : "Admin account updated.");
    dashTabInner("adminmgmt");
  } catch (err) {
    showToast(errMsg(err, "Could not update this admin account."));
  }
}
async function deleteAdminAccount(email: string) {
  if (!window.confirm(`Delete the admin account for ${email}? This can't be undone.`)) return;
  try {
    await api.adminDeleteAdmin(email);
    showToast("Admin account deleted.");
    dashTabInner("adminmgmt");
  } catch (err) {
    showToast(errMsg(err, "Could not delete this admin account."));
  }
}
async function adminCreateAdminAccount(e: Event): Promise<boolean> {
  e.preventDefault();
  const name = $<HTMLInputElement>("aaName").value;
  const email = $<HTMLInputElement>("aaEmail").value;
  const password = $<HTMLInputElement>("aaPassword").value;
  try {
    await api.adminCreateAdmin(name, email, password);
    showToast("Admin account created.");
    dashTabInner("adminmgmt");
  } catch (err) {
    showToast(errMsg(err, "Could not create admin account."));
  }
  return false;
}

function activityLogRowHtml(a: ActivityLogEntry): string {
  return `
    <tr style="border-top:1px solid var(--color-border)">
      <td class="px-3 py-2.5 whitespace-nowrap">${a.createdAt.slice(0, 19).replace("T", " ")}</td>
      <td class="px-3 py-2.5 capitalize">${a.action.replace(/_/g, " ")}</td>
      <td class="px-3 py-2.5">${a.userEmail || "&mdash;"}</td>
      <td class="px-3 py-2.5">${a.performedBy || "&mdash;"} ${a.performedByRole ? `(${a.performedByRole})` : ""}</td>
      <td class="px-3 py-2.5">${a.remarks || "&mdash;"}</td>
    </tr>`;
}

async function adminClearActivityLogAction() {
  if (!window.confirm(`Clear the entire activity log (${adminActivityList.length} record${adminActivityList.length === 1 ? "" : "s"})? This can't be undone.`)) return;
  try {
    await api.adminClearActivityLog();
    showToast("Activity log cleared.");
    dashTabInner("activity");
  } catch (err) {
    showToast(errMsg(err, "Could not clear the activity log."));
  }
}

function adminSeekerDetailHtml(d: { profile: AuthUser; applications: (Application & { vacancyTitle?: string; vacancyEmployer?: string })[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] }): string {
  const p = d.profile;
  return `
    <button onclick="adminBackFromSeekerDetail()" class="text-sm font-medium mb-4 inline-flex items-center gap-1" style="color:var(--color-primary)">&larr; ${adminSeekerDetailReturnToEmployer ? "Back to Employer" : "Back to list"}</button>
    <h1 class="font-display text-2xl font-semibold mb-1">${p.name || p.email}</h1>
    <p class="text-sm mb-4" style="color:var(--color-muted)">${p.email}</p>
    ${verificationStatusCardHtml(p)}
    ${fullSeekerProfileSectionsHtml(p, d.documents)}
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">IX. Application Information</h3>
    <div class="space-y-3 mb-6 stagger-grid">${d.applications.map(seekerApplicationRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No applications yet.</p>`}</div>
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">X. Verification History</h3>
    ${historyTimelineHtml(d.history)}
  `;
}
function adminEmployerDetailHtml(d: { profile: AuthUser; vacancies: Vacancy[]; applications: any[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] }): string {
  const p = d.profile;
  return `
    <button onclick="adminBackFromEmployerDetail()" class="text-sm font-medium mb-4 inline-flex items-center gap-1" style="color:var(--color-primary)">&larr; Back to list</button>
    <h1 class="font-display text-2xl font-semibold mb-1">${p.employerBusinessName || p.employerCompanyName || p.name}</h1>
    <p class="text-sm mb-4" style="color:var(--color-muted)">${p.email}</p>
    ${verificationStatusCardHtml(p)}
    ${fullEmployerProfileSectionsHtml(p, d.documents, d.vacancies)}
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">IX. Application Information</h3>
    <div class="space-y-3 mb-6 stagger-grid">${(d.applications || []).map((a: any) => adminEmployerApplicantRowHtml(a)).join("") || `<p class="text-sm" style="color:var(--color-muted)">No applications yet.</p>`}</div>
    <h3 class="font-display text-base font-semibold mb-3" style="color:var(--color-primary)">X. Verification History</h3>
    ${historyTimelineHtml(d.history)}
  `;
}

async function renderAdminDash(tab: string) {
  const content = $("dashContent");

  if (tab === "reports") {
    await renderAdminReports();
    return;
  }

  if (tab === "overview") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Admin Dashboard</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    let seekers: any[] = [], employers: any[] = [], staff: AuthUser[] = [];
    try {
      [seekers, employers, staff] = await Promise.all([api.adminGetSeekers(), api.adminGetEmployers(), api.adminGetStaff()]);
    } catch {}
    if (currentUser?.role !== "admin" || currentDashTab !== "overview") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Admin Dashboard</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Complete oversight of every account, profile, and verification history in the system.</p>
      <div class="grid sm:grid-cols-4 gap-4 mb-8 stagger-grid">
        <div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${seekers.length}</div><div class="text-xs" style="color:var(--color-muted)">Job Seekers</div></div>
        <div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${employers.length}</div><div class="text-xs" style="color:var(--color-muted)">Employers</div></div>
        <div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${staff.length}</div><div class="text-xs" style="color:var(--color-muted)">Staff Accounts</div></div>
        <div class="card rounded-xl p-5"><div class="text-2xl font-display font-bold" style="color:var(--color-primary)">${seekers.filter((s) => s.verificationStatus === "verified").length + employers.filter((e) => e.verificationStatus === "verified").length}</div><div class="text-xs" style="color:var(--color-muted)">Verified Accounts</div></div>
      </div>
    `;
    return;
  }

  if (tab === "seekers") {
    if (adminSeekerDetailEmail && adminSeekerDetail) {
      content.innerHTML = adminSeekerDetailHtml(adminSeekerDetail);
      return;
    }
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Job Seekers</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      adminSeekersList = await api.adminGetSeekers();
    } catch {
      adminSeekersList = [];
    }
    if (currentUser?.role !== "admin" || currentDashTab !== "seekers") return;
    {
      const filtered = adminSeekerFilter ? adminSeekersList.filter((s) => s.verificationStatus === adminSeekerFilter) : adminSeekersList;
      content.innerHTML = `
        <h1 class="font-display text-2xl font-semibold mb-1">Job Seekers</h1>
        <p class="text-sm mb-4" style="color:var(--color-muted)">Only Staff-verified profiles are shown by default (Section 24) &mdash; use the filter to see Pending, Incomplete, or all ${adminSeekersList.length} registered account(s).</p>
        <div class="mb-4">${statusFilterSelectHtml("adminSeekerFilterSelect", adminSeekerFilter, "adminFilterSeekers()")}</div>
        <div class="space-y-3 stagger-grid">${filtered.map(adminSeekerListRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No Job Seekers in this category.</p>`}</div>
      `;
    }
    return;
  }

  if (tab === "employers") {
    if (adminEmployerDetailEmail && adminEmployerDetail) {
      content.innerHTML = adminEmployerDetailHtml(adminEmployerDetail);
      return;
    }
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Employers</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      adminEmployersList = await api.adminGetEmployers();
    } catch {
      adminEmployersList = [];
    }
    if (currentUser?.role !== "admin" || currentDashTab !== "employers") return;
    {
      const filtered = adminEmployerFilter ? adminEmployersList.filter((e) => e.verificationStatus === adminEmployerFilter) : adminEmployersList;
      content.innerHTML = `
        <h1 class="font-display text-2xl font-semibold mb-1">Employers</h1>
        <p class="text-sm mb-4" style="color:var(--color-muted)">Only Staff-verified profiles are shown by default (Section 24) &mdash; use the filter to see Pending, Incomplete, or all ${adminEmployersList.length} registered account(s).</p>
        <div class="mb-4">${statusFilterSelectHtml("adminEmployerFilterSelect", adminEmployerFilter, "adminFilterEmployers()")}</div>
        <div class="space-y-3 stagger-grid">${filtered.map(adminEmployerListRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No Employers in this category.</p>`}</div>
      `;
    }
    return;
  }

  if (tab === "vacancyInventory") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Vacancy Inventory</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading vacancies and hired job seekers&hellip;</p>`;
    let inventoryVacancies: Vacancy[];
    let inventoryApplications: (Application & { seekerEmail: string; seekerName: string; vacancyTitle: string; vacancyEmployer: string })[];
    try {
      [inventoryVacancies, inventoryApplications] = await Promise.all([api.adminGetVacancies(), api.adminGetApplications()]);
    } catch (err) {
      if (currentUser?.role !== "admin" || currentDashTab !== "vacancyInventory") return;
      showToast(errMsg(err, "Could not load the vacancy inventory."));
      content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Vacancy Inventory</h1><p class="text-sm" style="color:var(--color-muted)">The inventory could not be loaded. Please try again.</p>`;
      return;
    }
    if (currentUser?.role !== "admin" || currentDashTab !== "vacancyInventory") return;
    adminInventoryVacancies = inventoryVacancies;
    adminInventoryApplications = inventoryApplications;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Vacancy Inventory</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">Select a vacancy to view its details and hired job seekers.</p>
      <div class="space-y-3 stagger-grid">${inventoryVacancies.map(adminVacancyInventoryCardHtml).join("") || `<p class="text-sm" style="color:var(--color-muted)">No vacancies have been posted.</p>`}</div>
    `;
    return;
  }

  if (tab === "applications") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Application Monitoring</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    let apps: (Application & { seekerEmail: string; seekerName: string; vacancyTitle: string; vacancyEmployer: string })[] = [];
    try {
      apps = await api.adminGetApplications();
    } catch {}
    if (currentUser?.role !== "admin" || currentDashTab !== "applications") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Application Monitoring</h1>
      <p class="text-sm mb-6" style="color:var(--color-muted)">System-wide, read-only view. Job Seekers apply directly to Employers, and the Employer decides &mdash; this is for oversight only.</p>
      <div class="space-y-3 stagger-grid">${apps.map(staffApplicationRow).join("") || `<p class="text-sm" style="color:var(--color-muted)">No applications yet.</p>`}</div>
    `;
    return;
  }

  if (tab === "staffmgmt") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Staff Accounts</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      adminStaffList = await api.adminGetStaff();
    } catch {
      adminStaffList = [];
    }
    if (currentUser?.role !== "admin" || currentDashTab !== "staffmgmt") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Staff Accounts</h1>
      <p class="text-sm mb-4" style="color:var(--color-muted)">PESO Staff accounts are provisioned here, not through public registration.</p>
      <div class="card rounded-xl p-6 mb-6">
        <h3 class="font-semibold text-sm mb-3">Create New Staff Account</h3>
        <form onsubmit="return adminCreateStaffAccount(event)" class="grid sm:grid-cols-3 gap-3 items-end">
          <div><label for="asName" class="text-xs font-semibold block mb-1.5">Full Name</label><input id="asName" required class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          <div><label for="asEmail" class="text-xs font-semibold block mb-1.5">Email</label><input id="asEmail" type="email" required class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          <div>${passwordFieldHtml("asPassword", "Temporary Password", { required: true, minlength: 6 })}</div>
          <div class="sm:col-span-3"><button type="submit" class="btn-primary text-sm font-semibold px-4 py-2 rounded-lg">Create Staff Account</button></div>
        </form>
      </div>
      <h3 class="font-semibold text-sm mb-3">Existing Staff (${adminStaffList.length})</h3>
      <div class="space-y-2 stagger-grid">
        ${adminStaffList.map(staffAccountRowHtml).join("") || `<p class="text-sm" style="color:var(--color-muted)">No staff accounts yet.</p>`}
      </div>
    `;
    return;
  }

  if (tab === "adminmgmt") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Admin Accounts</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      adminAdminsList = await api.adminGetAdmins();
    } catch {
      adminAdminsList = [];
    }
    if (currentUser?.role !== "admin" || currentDashTab !== "adminmgmt") return;
    content.innerHTML = `
      <h1 class="font-display text-2xl font-semibold mb-1">Admin Accounts</h1>
      <p class="text-sm mb-4" style="color:var(--color-muted)">Full system-access accounts. You can add new Admin accounts and edit any Admin account's name or password here, including your own.</p>
      <div class="card rounded-xl p-6 mb-6">
        <h3 class="font-semibold text-sm mb-3">Create New Admin Account</h3>
        <form onsubmit="return adminCreateAdminAccount(event)" class="grid sm:grid-cols-3 gap-3 items-end">
          <div><label for="aaName" class="text-xs font-semibold block mb-1.5">Full Name</label><input id="aaName" required class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)"></div>
          <div><label for="aaEmail" class="text-xs font-semibold block mb-1.5">Username/Email</label><input id="aaEmail" type="text" required class="w-full border rounded-lg px-3 py-2 text-sm" style="border-color:var(--color-border)" placeholder="e.g. admin2 or name@gmail.com"></div>
          <div>${passwordFieldHtml("aaPassword", "Temporary Password", { required: true, minlength: 6 })}</div>
          <div class="sm:col-span-3"><button type="submit" class="btn-primary text-sm font-semibold px-4 py-2 rounded-lg">Create Admin Account</button></div>
        </form>
      </div>
      <h3 class="font-semibold text-sm mb-3">Existing Admins (${adminAdminsList.length})</h3>
      <div class="space-y-2 stagger-grid">
        ${adminAdminsList.map(adminAccountRowHtml).join("") || `<p class="text-sm" style="color:var(--color-muted)">No admin accounts yet.</p>`}
      </div>
    `;
    return;
  }

  if (tab === "activity") {
    content.innerHTML = `<h1 class="font-display text-2xl font-semibold mb-1">Activity Log</h1><p class="text-sm mb-6" style="color:var(--color-muted)">Loading&hellip;</p>`;
    try {
      adminActivityList = await api.adminGetActivityLog(300);
    } catch {
      adminActivityList = [];
    }
    if (currentUser?.role !== "admin" || currentDashTab !== "activity") return;
    content.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-1">
        <h1 class="font-display text-2xl font-semibold">Activity Log</h1>
        ${adminActivityList.length ? `<button onclick="adminClearActivityLogAction()" class="text-xs font-semibold px-3 py-1.5 rounded-lg border flex-shrink-0" style="border-color:var(--color-border); color:var(--color-muted)">Clear Activity Log</button>` : ""}
      </div>
      <p class="text-sm mb-4" style="color:var(--color-muted)">Most recent ${adminActivityList.length} system events (newest first).</p>
      <div class="card rounded-xl overflow-hidden overflow-x-auto">
        <table class="w-full text-xs">
          <thead><tr style="background:var(--color-bg)">
            <th class="text-left px-3 py-2.5 font-semibold">Date/Time</th>
            <th class="text-left px-3 py-2.5 font-semibold">Action</th>
            <th class="text-left px-3 py-2.5 font-semibold">User</th>
            <th class="text-left px-3 py-2.5 font-semibold">Performed By</th>
            <th class="text-left px-3 py-2.5 font-semibold">Remarks</th>
          </tr></thead>
          <tbody>${adminActivityList.map(activityLogRowHtml).join("") || `<tr><td class="px-3 py-4 text-center" colspan="5" style="color:var(--color-muted)">No activity yet.</td></tr>`}</tbody>
        </table>
      </div>
    `;
    return;
  }
}


// The markup uses inline onclick/onsubmit/oninput handlers (ported from the original prototype),
// so these need to be reachable from window.
declare global {
  interface Window {
    nav: typeof nav;
    toggleMobileMenu: typeof toggleMobileMenu;
    closeMobileMenu: typeof closeMobileMenu;
    showPasswordVisibility: typeof showPasswordVisibility;
    hidePasswordVisibility: typeof hidePasswordVisibility;
    doLogin: typeof doLogin;
    doRegister: typeof doRegister;
    doLogout: typeof doLogout;
    closeLogoutConfirmModal: typeof closeLogoutConfirmModal;
    confirmLogout: typeof confirmLogout;
    closeHiredNotice: typeof closeHiredNotice;
    changeAvatar: typeof changeAvatar;
    doResendVerification: typeof doResendVerification;
    openVerificationEmail: typeof openVerificationEmail;
    doForgotPassword: typeof doForgotPassword;
    doResetPassword: typeof doResetPassword;
    previewDocument: typeof previewDocument;
    closeDocPreview: typeof closeDocPreview;
    openJob: typeof openJob;
    applyToJob: typeof applyToJob;
    cancelStaffReferralAction: typeof cancelStaffReferralAction;
    dashTab: typeof dashTab;
    toggleDashMenu: typeof toggleDashMenu;
    closeDashMenu: typeof closeDashMenu;
    adminSelectReportDate: typeof adminSelectReportDate;
    adminChangeReportMonth: typeof adminChangeReportMonth;
    renderAdminReports: typeof renderAdminReports;
    downloadAdminDailyReport: typeof downloadAdminDailyReport;
    searchVacancyLocations: typeof searchVacancyLocations;
    selectVacancyLocationResult: typeof selectVacancyLocationResult;
    vacancyLocationTextChanged: typeof vacancyLocationTextChanged;
    confirmVacancyLocation: typeof confirmVacancyLocation;
    clearVacancyLocation: typeof clearVacancyLocation;
    saveProfile: typeof saveProfile;
    renderJobsList: typeof renderJobsList;
    jobsFilterChanged: typeof jobsFilterChanged;
    jobsGoToPage: typeof jobsGoToPage;
    resolveUnsavedModal: typeof resolveUnsavedModal;
    handleDocUpload: typeof handleDocUpload;
    removeDoc: typeof removeDoc;
    toggleNoDocuments: typeof toggleNoDocuments;
    selectLoginRole: typeof selectLoginRole;
    selectRegisterRole: typeof selectRegisterRole;
    doSubmitProfileForVerification: typeof doSubmitProfileForVerification;
    saveEmployerProfile: typeof saveEmployerProfile;
    doSubmitEmployerProfileForVerification: typeof doSubmitEmployerProfileForVerification;
    toggleNewVacancyForm: typeof toggleNewVacancyForm;
    openNewVacancyForm: typeof openNewVacancyForm;
    editVacancy: typeof editVacancy;
    cancelVacancyForm: typeof cancelVacancyForm;
    submitVacancyForm: typeof submitVacancyForm;
    staffFilterSeekers: typeof staffFilterSeekers;
    staffFilterEmployers: typeof staffFilterEmployers;
    adminFilterSeekers: typeof adminFilterSeekers;
    adminFilterEmployers: typeof adminFilterEmployers;
    staffOpenSeekerDetail: typeof staffOpenSeekerDetail;
    staffOpenEmployerDetail: typeof staffOpenEmployerDetail;
    staffBackFromSeekerDetail: typeof staffBackFromSeekerDetail;
    staffBackFromEmployerDetail: typeof staffBackFromEmployerDetail;
    staffVerifySeekerAction: typeof staffVerifySeekerAction;
    staffReturnSeekerAction: typeof staffReturnSeekerAction;
    openReturnCompletionModal: typeof openReturnCompletionModal;
    closeReturnCompletionModal: typeof closeReturnCompletionModal;
    clearReturnCompletionError: typeof clearReturnCompletionError;
    submitReturnForCompletion: typeof submitReturnForCompletion;
    staffRejectSeekerAction: typeof staffRejectSeekerAction;
    staffVerifyEmployerAction: typeof staffVerifyEmployerAction;
    staffReturnEmployerAction: typeof staffReturnEmployerAction;
    staffRejectEmployerAction: typeof staffRejectEmployerAction;
    staffApproveVacancyAction: typeof staffApproveVacancyAction;
    staffReturnVacancyAction: typeof staffReturnVacancyAction;
    staffRejectVacancyAction: typeof staffRejectVacancyAction;
    referVacancyChanged: typeof referVacancyChanged;
    referSeekerAction: typeof referSeekerAction;
    deleteNotificationAction: typeof deleteNotificationAction;
    clearAllNotificationsAction: typeof clearAllNotificationsAction;
    adminClearActivityLogAction: typeof adminClearActivityLogAction;
    openVacancyDetailModal: typeof openVacancyDetailModal;
    openVacancyDetailsModal: typeof openVacancyDetailsModal;
    adminOpenVacancyInventoryDetails: typeof adminOpenVacancyInventoryDetails;
    closeVacancyDetailModal: typeof closeVacancyDetailModal;
    staffSuspendEmployerAction: typeof staffSuspendEmployerAction;
    staffReactivateEmployerAction: typeof staffReactivateEmployerAction;
    submitDraftVacancy: typeof submitDraftVacancy;
    closeVacancyAction: typeof closeVacancyAction;
    updateEmployerApplicationStatusAction: typeof updateEmployerApplicationStatusAction;
    openEmployerSeekerProfile: typeof openEmployerSeekerProfile;
    closeSeekerProfileModal: typeof closeSeekerProfileModal;
    employerTypeChanged: typeof employerTypeChanged;
    adminOpenSeekerDetail: typeof adminOpenSeekerDetail;
    adminOpenEmployerDetail: typeof adminOpenEmployerDetail;
    adminViewApplicantSeekerProfile: typeof adminViewApplicantSeekerProfile;
    adminViewInventorySeekerProfile: typeof adminViewInventorySeekerProfile;
    adminDeleteSeekerAction: typeof adminDeleteSeekerAction;
    adminDeleteEmployerAction: typeof adminDeleteEmployerAction;
    adminDeleteVacancyAction: typeof adminDeleteVacancyAction;
    adminDeleteApplicationAction: typeof adminDeleteApplicationAction;
    adminBackFromSeekerDetail: typeof adminBackFromSeekerDetail;
    adminBackFromEmployerDetail: typeof adminBackFromEmployerDetail;
    adminCreateStaffAccount: typeof adminCreateStaffAccount;
    startStaffEdit: typeof startStaffEdit;
    cancelStaffEdit: typeof cancelStaffEdit;
    saveStaffEdit: typeof saveStaffEdit;
    deleteStaffAccount: typeof deleteStaffAccount;
    adminCreateAdminAccount: typeof adminCreateAdminAccount;
    startAdminEdit: typeof startAdminEdit;
    cancelAdminEdit: typeof cancelAdminEdit;
    saveAdminEdit: typeof saveAdminEdit;
    deleteAdminAccount: typeof deleteAdminAccount;
    openSeekerEmailModal: typeof openSeekerEmailModal;
    closeSeekerEmailModal: typeof closeSeekerEmailModal;
    submitSeekerEmail: typeof submitSeekerEmail;
  }
}
window.nav = nav;
window.toggleMobileMenu = toggleMobileMenu;
window.closeMobileMenu = closeMobileMenu;
window.showPasswordVisibility = showPasswordVisibility;
window.hidePasswordVisibility = hidePasswordVisibility;
window.doLogin = doLogin;
window.doRegister = doRegister;
window.doLogout = doLogout;
window.closeLogoutConfirmModal = closeLogoutConfirmModal;
window.confirmLogout = confirmLogout;
window.closeHiredNotice = closeHiredNotice;
window.openSeekerEmailModal = openSeekerEmailModal;
window.closeSeekerEmailModal = closeSeekerEmailModal;
window.submitSeekerEmail = submitSeekerEmail;
window.changeAvatar = changeAvatar;
window.doResendVerification = doResendVerification;
window.openVerificationEmail = openVerificationEmail;
window.doForgotPassword = doForgotPassword;
window.doResetPassword = doResetPassword;
window.previewDocument = previewDocument;
window.closeDocPreview = closeDocPreview;
window.openJob = openJob;
window.applyToJob = applyToJob;
window.cancelStaffReferralAction = cancelStaffReferralAction;
window.dashTab = dashTab;
window.toggleDashMenu = toggleDashMenu;
window.closeDashMenu = closeDashMenu;
window.adminSelectReportDate = adminSelectReportDate;
window.adminChangeReportMonth = adminChangeReportMonth;
window.renderAdminReports = renderAdminReports;
window.downloadAdminDailyReport = downloadAdminDailyReport;
window.searchVacancyLocations = searchVacancyLocations;
window.selectVacancyLocationResult = selectVacancyLocationResult;
window.vacancyLocationTextChanged = vacancyLocationTextChanged;
window.confirmVacancyLocation = confirmVacancyLocation;
window.clearVacancyLocation = clearVacancyLocation;
window.saveProfile = saveProfile;
window.renderJobsList = renderJobsList;
window.jobsFilterChanged = jobsFilterChanged;
window.jobsGoToPage = jobsGoToPage;
window.resolveUnsavedModal = resolveUnsavedModal;
window.handleDocUpload = handleDocUpload;
window.removeDoc = removeDoc;
window.toggleNoDocuments = toggleNoDocuments;
window.selectLoginRole = selectLoginRole;
window.selectRegisterRole = selectRegisterRole;
window.doSubmitProfileForVerification = doSubmitProfileForVerification;
window.saveEmployerProfile = saveEmployerProfile;
window.doSubmitEmployerProfileForVerification = doSubmitEmployerProfileForVerification;
window.toggleNewVacancyForm = toggleNewVacancyForm;
window.openNewVacancyForm = openNewVacancyForm;
window.editVacancy = editVacancy;
window.cancelVacancyForm = cancelVacancyForm;
window.submitVacancyForm = submitVacancyForm;
window.staffFilterSeekers = staffFilterSeekers;
window.staffFilterEmployers = staffFilterEmployers;
window.adminFilterSeekers = adminFilterSeekers;
window.adminFilterEmployers = adminFilterEmployers;
window.staffOpenSeekerDetail = staffOpenSeekerDetail;
window.staffOpenEmployerDetail = staffOpenEmployerDetail;
window.staffBackFromSeekerDetail = staffBackFromSeekerDetail;
window.staffBackFromEmployerDetail = staffBackFromEmployerDetail;
window.staffVerifySeekerAction = staffVerifySeekerAction;
window.staffReturnSeekerAction = staffReturnSeekerAction;
window.openReturnCompletionModal = openReturnCompletionModal;
window.closeReturnCompletionModal = closeReturnCompletionModal;
window.clearReturnCompletionError = clearReturnCompletionError;
window.submitReturnForCompletion = submitReturnForCompletion;
window.staffRejectSeekerAction = staffRejectSeekerAction;
window.staffVerifyEmployerAction = staffVerifyEmployerAction;
window.staffReturnEmployerAction = staffReturnEmployerAction;
window.staffRejectEmployerAction = staffRejectEmployerAction;
window.staffApproveVacancyAction = staffApproveVacancyAction;
window.staffReturnVacancyAction = staffReturnVacancyAction;
window.staffRejectVacancyAction = staffRejectVacancyAction;
window.referVacancyChanged = referVacancyChanged;
window.referSeekerAction = referSeekerAction;
window.deleteNotificationAction = deleteNotificationAction;
window.clearAllNotificationsAction = clearAllNotificationsAction;
window.adminClearActivityLogAction = adminClearActivityLogAction;
window.openVacancyDetailModal = openVacancyDetailModal;
window.openVacancyDetailsModal = openVacancyDetailsModal;
window.adminOpenVacancyInventoryDetails = adminOpenVacancyInventoryDetails;
window.closeVacancyDetailModal = closeVacancyDetailModal;
window.staffSuspendEmployerAction = staffSuspendEmployerAction;
window.staffReactivateEmployerAction = staffReactivateEmployerAction;
window.submitDraftVacancy = submitDraftVacancy;
window.closeVacancyAction = closeVacancyAction;
window.updateEmployerApplicationStatusAction = updateEmployerApplicationStatusAction;
window.openEmployerSeekerProfile = openEmployerSeekerProfile;
window.closeSeekerProfileModal = closeSeekerProfileModal;
window.employerTypeChanged = employerTypeChanged;
window.adminOpenSeekerDetail = adminOpenSeekerDetail;
window.adminOpenEmployerDetail = adminOpenEmployerDetail;
window.adminViewApplicantSeekerProfile = adminViewApplicantSeekerProfile;
window.adminViewInventorySeekerProfile = adminViewInventorySeekerProfile;
window.adminDeleteSeekerAction = adminDeleteSeekerAction;
window.adminDeleteEmployerAction = adminDeleteEmployerAction;
window.adminDeleteVacancyAction = adminDeleteVacancyAction;
window.adminDeleteApplicationAction = adminDeleteApplicationAction;
window.adminBackFromSeekerDetail = adminBackFromSeekerDetail;
window.adminBackFromEmployerDetail = adminBackFromEmployerDetail;
window.adminCreateStaffAccount = adminCreateStaffAccount;
window.startStaffEdit = startStaffEdit;
window.cancelStaffEdit = cancelStaffEdit;
window.saveStaffEdit = saveStaffEdit;
window.deleteStaffAccount = deleteStaffAccount;
window.adminCreateAdminAccount = adminCreateAdminAccount;
window.startAdminEdit = startAdminEdit;
window.cancelAdminEdit = cancelAdminEdit;
window.saveAdminEdit = saveAdminEdit;
window.deleteAdminAccount = deleteAdminAccount;

/* Track edits made inside the profile form so we can warn before they're lost.
 * (File uploads no longer count — those save to the server immediately.) */
["input", "change"].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("#profileForm") && target.id !== "pDocInput") {
      profileDirty = true;
    }
  });
});

/* ================= INIT ================= */
async function init() {
  try {
    await refreshVacancies();
  } catch {
    showToast("Could not reach the PESO server. Make sure the backend is running.");
  }
  await refreshHomeStats();
  window.setInterval(refreshHomeStats, 30000);
  window.setInterval(() => void refreshSeekerNotifications(), 15000);
  window.setInterval(updateRegistrationExpiryTimers, 1000);
  updateRegistrationExpiryTimers();
  updateActiveNavLink("home"); // the home view starts active server-side in index.html

  const handledAuthLink = await handleAuthLinkParams();
  if (handledAuthLink) {
    renderNavAuth();
    return;
  }

  if (api.getToken()) {
    try {
      currentUser = await api.me();
      await loadUserData();
    } catch {
      // Stale/expired token — quietly fall back to logged-out state.
      currentUser = null;
    }
  }
  renderNavAuth();
  // Re-render whichever view is currently active now that data has arrived.
  const activeView = document.querySelector(".view.active");
  if (activeView?.id === "view-jobs") renderJobsList();
  if (activeView?.id === "view-dashboard" && !profileDirty) dashTabInner(currentDashTab);
}
init();
