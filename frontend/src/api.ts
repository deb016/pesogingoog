import type { ActivityLogEntry, Application, AppNotification, AuthUser, DocumentMeta, StaffReferral, Vacancy, VerificationHistoryEntry } from "./types";

/** Where the backend lives. Override at build time with VITE_API_BASE if you deploy the
 *  API somewhere other than localhost:3001 (see .env.example). */
export const API_BASE: string = (import.meta as any).env?.VITE_API_BASE || "http://localhost:3001";

const TOKEN_KEY = "peso_token";

export interface AdminDailyReport {
  date: string;
  vacancies: {
    title: string;
    employer: string;
    location: string;
    slots: number;
    posted: string;
    status: string;
  }[];
  seekers: {
    name: string;
    registeredAt: string;
    educationLevel: string;
    skills: string;
    verificationStatus: string;
  }[];
  datesWithData: Record<string, number>;
}
export interface LocationSearchResult {
  label: string;
  latitude: number;
  longitude: number;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/** Thrown for any non-2xx response; carries the backend's error message when it has one. */
export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach the PESO server. Is the backend running?", 0);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    if (res.status === 401) clearToken();
    throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data);
  }
  return data as T;
}

/* ================= AUTH ================= */
/** Registration no longer logs the person in directly — Job Seekers/Employers must verify
 *  their Gmail address first (Section 6), so this only returns a confirmation message. */
export async function register(
  name: string,
  email: string,
  password: string,
  confirmPassword: string,
  role: "job_seeker" | "employer" = "job_seeker",
): Promise<{ requiresVerification: boolean; email: string; registrationExpiresAt: string; message: string }> {
  return request("POST", "/api/auth/register", { name, email, password, confirmPassword, role });
}

/** The backend authenticates the account and returns its stored role for role-based access. */
export async function login(email: string, password: string): Promise<AuthUser> {
  const data = await request<{ token: string; user: AuthUser }>("POST", "/api/auth/login", { email, password });
  setToken(data.token);
  return data.user;
}

export async function verifyEmail(token: string): Promise<AuthUser> {
  const data = await request<{ token: string; user: AuthUser }>("POST", "/api/auth/verify-email", { token });
  setToken(data.token);
  return data.user;
}

export async function resendVerification(email: string): Promise<{ message: string }> {
  return request("POST", "/api/auth/resend-verification", { email });
}

export async function forgotPassword(email: string): Promise<{ message: string }> {
  return request("POST", "/api/auth/forgot-password", { email });
}

export async function resetPassword(token: string, password: string, confirmPassword: string): Promise<{ message: string }> {
  return request("POST", "/api/auth/reset-password", { token, password, confirmPassword });
}

export async function logout(): Promise<void> {
  try {
    await request("POST", "/api/auth/logout");
  } finally {
    clearToken();
  }
}

export async function me(): Promise<AuthUser> {
  const data = await request<{ user: AuthUser }>("GET", "/api/auth/me");
  return data.user;
}

export async function getAvatar(): Promise<string> {
  const data = await request<{ avatarData: string }>("GET", "/api/profile/avatar");
  return data.avatarData;
}

export async function updateAvatar(avatarData: string): Promise<string> {
  const data = await request<{ avatarData: string }>("PUT", "/api/profile/avatar", { avatarData });
  return data.avatarData;
}

/* ================= VACANCIES ================= */
export async function getVacancies(): Promise<Vacancy[]> {
  const data = await request<{ vacancies: Vacancy[] }>("GET", "/api/vacancies");
  return data.vacancies;
}

export async function getVacancy(id: number): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("GET", `/api/vacancies/${id}`);
  return data.vacancy;
}

export async function getPublicStats(): Promise<{ openVacancies: number; placementsThisMonth: number; partnerEmployers: number }> {
  const data = await request<{ stats: { openVacancies: number; placementsThisMonth: number; partnerEmployers: number } }>("GET", "/api/public/stats");
  return data.stats;
}

/* ================= PROFILE (Job Seeker) ================= */
export async function updateProfile(profile: Partial<AuthUser>): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("PUT", "/api/profile", profile);
  return data.profile;
}

/** Locks the profile and moves it to Pending Verification (or re-locks it after the
 *  seeker fixes a Returned for Completion profile). */
export async function submitProfileForVerification(): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", "/api/profile/submit");
  return data.profile;
}

export async function getProfileHistory(): Promise<VerificationHistoryEntry[]> {
  const data = await request<{ profile: AuthUser; history: VerificationHistoryEntry[] }>("GET", "/api/profile");
  return data.history;
}
export async function requestProfileEdit(remarks: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", "/api/profile/edit-request", { remarks });
  return data.profile;
}

/* ================= EMPLOYER ================= */
export async function getEmployerProfile(): Promise<{ profile: AuthUser; history: VerificationHistoryEntry[] }> {
  return request("GET", "/api/employer/profile");
}
export async function updateEmployerProfile(profile: Partial<AuthUser>): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("PUT", "/api/employer/profile", profile);
  return data.profile;
}
export async function submitEmployerProfileForVerification(): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", "/api/employer/profile/submit");
  return data.profile;
}
export async function getEmployerVacancies(): Promise<Vacancy[]> {
  const data = await request<{ vacancies: Vacancy[] }>("GET", "/api/employer/vacancies");
  return data.vacancies;
}
export async function searchEmployerLocations(query: string): Promise<LocationSearchResult[]> {
  const data = await request<{ locations: LocationSearchResult[] }>("GET", `/api/employer/location-search?q=${encodeURIComponent(query)}`);
  return data.locations;
}
export async function reverseSearchEmployerLocation(latitude: number, longitude: number): Promise<LocationSearchResult> {
  const query = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
  const data = await request<{ location: LocationSearchResult }>("GET", `/api/employer/location-reverse?${query}`);
  return data.location;
}
export async function createEmployerVacancy(v: Partial<Vacancy> & { isDraft?: boolean }): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("POST", "/api/employer/vacancies", v);
  return data.vacancy;
}
export async function updateEmployerVacancy(id: number, v: Partial<Vacancy>): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("PUT", `/api/employer/vacancies/${id}`, v);
  return data.vacancy;
}
export async function submitEmployerVacancy(id: number): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("POST", `/api/employer/vacancies/${id}/submit`);
  return data.vacancy;
}
export async function repostEmployerVacancy(id: number): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("POST", `/api/employer/vacancies/${id}/repost`);
  return data.vacancy;
}
export async function closeEmployerVacancy(id: number): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("POST", `/api/employer/vacancies/${id}/close`);
  return data.vacancy;
}
type EmployerReferral = Application & {
  seekerName: string; seekerContact: string; seekerSkills: string; seekerEducation: string; seekerCourse: string; seekerExperience: string; vacancyTitle: string;
};
export async function getEmployerApplications(): Promise<EmployerReferral[]> {
  const data = await request<{ applications: EmployerReferral[] }>("GET", "/api/employer/applications");
  return data.applications;
}
export async function updateEmployerApplicationStatus(id: number, employerStatus: string, remarks?: string): Promise<Application> {
  const data = await request<{ application: Application }>("PATCH", `/api/employer/applications/${id}`, { employerStatus, remarks });
  return data.application;
}
/** Full Seeker profile for one of the employer's own applicants (Section: View Seeker Profile).
 * Reuses the same account data already stored for the seeker — nothing new is created. */
export async function getEmployerApplicantProfile(applicationId: number): Promise<{ profile: AuthUser; documents: DocumentMeta[]; vacancyTitle: string }> {
  return request("GET", `/api/employer/applications/${applicationId}/seeker`);
}

/* ================= STAFF ================= */
export async function staffGetProfileEditRequests(): Promise<AuthUser[]> {
  const data = await request<{ requests: AuthUser[] }>("GET", "/api/staff/profile-edit-requests");
  return data.requests;
}
export async function staffDecideProfileEditRequest(email: string, approve: boolean, remarks = ""): Promise<AuthUser> {
  const decision = approve ? "approve" : "decline";
  const data = await request<{ profile: AuthUser }>(
    "POST",
    `/api/staff/profile-edit-requests/${encodeURIComponent(email)}/${decision}`,
    { remarks },
  );
  return data.profile;
}
export async function staffGetSeekers(status?: string): Promise<(AuthUser & { documentCount: number })[]> {
  const data = await request<{ seekers: (AuthUser & { documentCount: number })[] }>("GET", `/api/staff/seekers${status ? `?status=${status}` : ""}`);
  return data.seekers;
}
export async function staffGetSeeker(email: string): Promise<{ profile: AuthUser; documents: DocumentMeta[]; applications: (Application & { vacancyTitle?: string; vacancyEmployer?: string })[]; history: VerificationHistoryEntry[] }> {
  return request("GET", `/api/staff/seekers/${encodeURIComponent(email)}`);
}
export async function staffSendSeekerEmail(applicationId: number, message: string): Promise<void> {
  await request("POST", `/api/staff/applications/${applicationId}/email`, { message });
}
export async function staffVerifySeeker(email: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/seekers/${encodeURIComponent(email)}/verify`);
  return data.profile;
}
export async function staffReturnSeeker(email: string, remarks: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/seekers/${encodeURIComponent(email)}/return`, { remarks });
  return data.profile;
}
export async function staffRejectSeeker(email: string, remarks: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/seekers/${encodeURIComponent(email)}/reject`, { remarks });
  return data.profile;
}
export async function staffGetEmployers(status?: string): Promise<AuthUser[]> {
  const data = await request<{ employers: AuthUser[] }>("GET", `/api/staff/employers${status ? `?status=${status}` : ""}`);
  return data.employers;
}
export async function staffGetEmployer(email: string): Promise<{ profile: AuthUser; vacancies: Vacancy[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] }> {
  return request("GET", `/api/staff/employers/${encodeURIComponent(email)}`);
}
export async function staffVerifyEmployer(email: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/employers/${encodeURIComponent(email)}/verify`);
  return data.profile;
}
export async function staffReturnEmployer(email: string, remarks: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/employers/${encodeURIComponent(email)}/return`, { remarks });
  return data.profile;
}
export async function staffRejectEmployer(email: string, remarks: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/employers/${encodeURIComponent(email)}/reject`, { remarks });
  return data.profile;
}
export async function staffSuspendEmployer(email: string, remarks: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/employers/${encodeURIComponent(email)}/suspend`, { remarks });
  return data.profile;
}
export async function staffReactivateEmployer(email: string): Promise<AuthUser> {
  const data = await request<{ profile: AuthUser }>("POST", `/api/staff/employers/${encodeURIComponent(email)}/reactivate`);
  return data.profile;
}
export async function staffGetVacancies(status?: string): Promise<Vacancy[]> {
  const data = await request<{ vacancies: Vacancy[] }>("GET", `/api/staff/vacancies${status ? `?status=${status}` : ""}`);
  return data.vacancies;
}
export async function staffApproveVacancy(id: number): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("POST", `/api/staff/vacancies/${id}/approve`);
  return data.vacancy;
}
export async function staffReturnVacancy(id: number, remarks: string): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("POST", `/api/staff/vacancies/${id}/return`, { remarks });
  return data.vacancy;
}
export async function staffRejectVacancy(id: number, remarks: string): Promise<Vacancy> {
  const data = await request<{ vacancy: Vacancy }>("POST", `/api/staff/vacancies/${id}/reject`, { remarks });
  return data.vacancy;
}
export async function staffGetApplications(): Promise<(Application & { seekerEmail: string; seekerName: string; seekerContact: string; vacancyTitle: string; vacancyEmployer: string })[]> {
  const data = await request<{ applications: any[] }>("GET", "/api/staff/applications");
  return data.applications;
}
/** Section 3: Refer Seeker — Staff picks an approved vacancy, sees only the Verified
 * Job Seekers who actually meet its requirements (Match Score >= 70%), and refers one. */
export type ReferralCandidate = {
  email: string;
  name: string;
  educationLevel: string;
  skills: string;
  experience: string;
  matchScore: number;
  matchBreakdown: { educationScore: number; skillsScore: number; experienceScore: number; totalScore: number };
};
export async function staffGetReferralCandidates(vacancyId: number): Promise<{ vacancy: Vacancy; candidates: ReferralCandidate[] }> {
  return request("GET", `/api/staff/refer/candidates/${vacancyId}`);
}
export async function staffReferSeeker(seekerEmail: string, vacancyId: number): Promise<Omit<StaffReferral, "vacancy"> & { seekerEmail: string; vacancyId: number }> {
  const data = await request<{ referral: Omit<StaffReferral, "vacancy"> & { seekerEmail: string; vacancyId: number } }>("POST", "/api/staff/refer", { seekerEmail, vacancyId });
  return data.referral;
}

/* ================= ADMIN ================= */
export async function adminGetSeekers(): Promise<(AuthUser & { profileComplete: boolean; applicationCount: number; documentCount: number })[]> {
  const data = await request<{ seekers: any[] }>("GET", "/api/admin/seekers");
  return data.seekers;
}
export async function adminGetSeeker(email: string): Promise<{ profile: AuthUser; applications: (Application & { vacancyTitle?: string; vacancyEmployer?: string })[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] }> {
  return request("GET", `/api/admin/seekers/${encodeURIComponent(email)}`);
}
export async function adminDeleteSeeker(email: string): Promise<void> {
  await request("DELETE", `/api/admin/seekers/${encodeURIComponent(email)}`);
}
export async function adminGetEmployers(): Promise<(AuthUser & { vacancyCount: number })[]> {
  const data = await request<{ employers: any[] }>("GET", "/api/admin/employers");
  return data.employers;
}
export async function adminGetEmployer(email: string): Promise<{ profile: AuthUser; vacancies: Vacancy[]; applications: any[]; documents: DocumentMeta[]; history: VerificationHistoryEntry[] }> {
  return request("GET", `/api/admin/employers/${encodeURIComponent(email)}`);
}
export async function adminDeleteEmployer(email: string): Promise<void> {
  await request("DELETE", `/api/admin/employers/${encodeURIComponent(email)}`);
}
export async function adminGetActivityLog(limit = 200): Promise<ActivityLogEntry[]> {
  const data = await request<{ activity: ActivityLogEntry[] }>("GET", `/api/admin/activity-log?limit=${limit}`);
  return data.activity;
}
export async function adminClearActivityLog(): Promise<void> {
  await request("DELETE", "/api/admin/activity-log");
}
export async function adminGetStaff(): Promise<AuthUser[]> {
  const data = await request<{ staff: AuthUser[] }>("GET", "/api/admin/staff");
  return data.staff;
}
export async function adminCreateStaff(name: string, email: string, password: string): Promise<AuthUser> {
  const data = await request<{ staff: AuthUser }>("POST", "/api/admin/staff", { name, email, password });
  return data.staff;
}
export async function adminUpdateStaff(email: string, name: string, password?: string): Promise<AuthUser> {
  const data = await request<{ staff: AuthUser }>("PATCH", `/api/admin/staff/${encodeURIComponent(email)}`, { name, password: password || undefined });
  return data.staff;
}
export async function adminDeleteStaff(email: string): Promise<void> {
  await request("DELETE", `/api/admin/staff/${encodeURIComponent(email)}`);
}
export async function adminGetAdmins(): Promise<AuthUser[]> {
  const data = await request<{ admins: AuthUser[] }>("GET", "/api/admin/admins");
  return data.admins;
}
export async function adminCreateAdmin(name: string, email: string, password: string): Promise<AuthUser> {
  const data = await request<{ admin: AuthUser }>("POST", "/api/admin/admins", { name, email, password });
  return data.admin;
}
export async function adminUpdateAdmin(email: string, name: string, password?: string): Promise<{ admin: AuthUser; selfPasswordChanged: boolean }> {
  const data = await request<{ admin: AuthUser; selfPasswordChanged: boolean }>("PATCH", `/api/admin/admins/${encodeURIComponent(email)}`, { name, password: password || undefined });
  return data;
}
export async function adminDeleteAdmin(email: string): Promise<void> {
  await request("DELETE", `/api/admin/admins/${encodeURIComponent(email)}`);
}
export async function adminGetVacancies(): Promise<Vacancy[]> {
  const data = await request<{ vacancies: Vacancy[] }>("GET", "/api/admin/vacancies");
  return data.vacancies;
}
export async function adminGetDailyReport(date: string, month: string): Promise<AdminDailyReport> {
  const params = new URLSearchParams({ date, month });
  return request("GET", `/api/admin/reports?${params}`);
}
export async function adminDownloadDailyReport(type: "vacancies" | "seekers" | "complete", date: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/admin/reports/${type}.pdf?date=${encodeURIComponent(date)}`, {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    });
  } catch {
    throw new ApiError("Can't reach the PESO server. Is the backend running?", 0);
  }
  if (!response.ok) {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (response.status === 401) clearToken();
    throw new ApiError(data.error || `Request failed (${response.status}).`, response.status, data);
  }
  return response.blob();
}
export async function adminDeleteVacancy(id: number): Promise<void> {
  await request("DELETE", `/api/admin/vacancies/${id}`);
}
export async function adminGetApplications(): Promise<(Application & { seekerEmail: string; seekerName: string; vacancyTitle: string; vacancyEmployer: string })[]> {
  const data = await request<{ applications: any[] }>("GET", "/api/admin/applications");
  return data.applications;
}
export async function adminDeleteApplication(id: number): Promise<void> {
  await request("DELETE", `/api/admin/applications/${id}`);
}

/* ================= APPLICATIONS (Job Seeker) ================= */
export async function getApplications(): Promise<Application[]> {
  const data = await request<{ applications: Application[] }>("GET", "/api/applications");
  return data.applications;
}

export async function getStaffReferrals(): Promise<StaffReferral[]> {
  const data = await request<{ referrals: StaffReferral[] }>("GET", "/api/referrals");
  return data.referrals;
}

export async function cancelStaffReferral(referralId: number): Promise<void> {
  await request("DELETE", `/api/referrals/${referralId}`);
}

export async function applyToJob(vacancyId: number): Promise<Application> {
  const data = await request<{ application: Application }>("POST", "/api/applications", { vacancyId });
  return data.application;
}

/* ================= NOTIFICATIONS ================= */
export async function getNotifications(): Promise<AppNotification[]> {
  const data = await request<{ notifications: AppNotification[] }>("GET", "/api/notifications");
  return data.notifications;
}

export async function markAllNotificationsRead(): Promise<void> {
  await request("POST", "/api/notifications/read-all");
}

export async function markNotificationRead(id: number): Promise<void> {
  await request("POST", `/api/notifications/${id}/read`);
}

export async function deleteNotification(id: number): Promise<void> {
  await request("DELETE", `/api/notifications/${id}`);
}

export async function clearAllNotifications(): Promise<void> {
  await request("DELETE", "/api/notifications");
}

/* ================= DOCUMENTS ================= */
export async function getDocuments(): Promise<DocumentMeta[]> {
  const data = await request<{ documents: DocumentMeta[] }>("GET", "/api/documents");
  return data.documents;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

export async function uploadDocument(file: File): Promise<DocumentMeta> {
  const dataBase64 = await fileToBase64(file);
  const data = await request<{ document: DocumentMeta }>("POST", "/api/documents", {
    fileName: file.name,
    mimeType: file.type,
    dataBase64,
  });
  return data.document;
}

export async function deleteDocument(id: number): Promise<void> {
  await request("DELETE", `/api/documents/${id}`);
}

/** Fetches an uploaded document's actual bytes (Sections 15–17) as a Blob so the frontend
 * can preview images/PDFs inline or offer a real download — used by Staff/Admin (any
 * document) and by the document's own owner (their own documents only; enforced server-side). */
export async function fetchDocumentFile(id: number): Promise<{ blob: Blob; mimeType: string }> {
  const res = await fetch(`${API_BASE}/api/documents/file/${id}`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (!res.ok) {
    let message = `Could not load document (${res.status}).`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {}
    throw new ApiError(message, res.status);
  }
  const blob = await res.blob();
  return { blob, mimeType: res.headers.get("Content-Type") || blob.type || "application/octet-stream" };
}
