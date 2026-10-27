export type EducationLevel =
  | "Elementary"
  | "Secondary"
  | "Senior High"
  | "Tertiary"
  | "Graduate Studies"
  | "Post-graduate";

export interface Vacancy {
  id: number;
  title: string;
  employer: string;
  category: string;
  location: string;
  salary: string;
  type: string;
  slots: number;
  posted: string;
  qualification: string[];
  description: string;
  /** Structured fields used by the match-score engine (in addition to the free-text qualification list shown to users) */
  minEducationLevel: EducationLevel;
  requiredSkills: string[];
  minExperienceYears: number;
  latitude?: number | null;
  longitude?: number | null;
  /** Employer/vacancy approval workflow (Section 9) — empty employerEmail + status
   *  "approved" for the original seeded demo vacancies with no owning employer account. */
  employerEmail: string;
  status: VacancyStatus;
  remarks: string;
  approvedBy: string;
  approvedAt: string;
  /** NSRP Form 2 — Vacancy Details / Qualification Requirements / Posting Details (Employer add-on) */
  workExperience: string;
  otherQualifications: string;
  acceptsPwd: "" | "Yes" | "No";
  pwdTypes: string[];
  acceptsReturningOfw: "" | "Yes" | "No";
  courseShsStrand: string;
  license: string;
  certification: string;
  eligibility: string;
  languageDialect: string;
  validUntil: string;
  expiryDays?: number;
}

export interface WorkExperienceEntry {
  companyName: string;
  address: string;
  position: string;
  status: string;
  dateFrom: string;
  dateTo: string;
}

export interface TrainingEntry {
  course: string;
  institution: string;
  hours: string;
  skillsAcquired: string;
  certificates: string;
}

export interface EligibilityEntry {
  name: string;
  dateTaken: string;
}

export interface LicenseEntry {
  name: string;
  validUntil: string;
}

export interface JobSeeker {
  name?: string;
  surname: string;
  firstName: string;
  middleName: string;
  suffix: string;
  dateOfBirth: string;
  sex: string;
  religion: string;
  civilStatus: string;
  houseStreet: string;
  barangay: string;
  municipality: string;
  province: string;
  tin: string;
  heightFt: string;
  contactNumber: string;
  email: string;
  disabilityTypes: string[];
  disabilityOthers: string;
  employmentStatus: string;
  employmentSubType: string;
  employmentSubTypeOthers: string;
  monthsLookingForWork: string;
  jobSeekerCategory: string[];
  terminatedAbroadCountry: string;
  jobSeekerCategoryOthers: string;
  isOFW: string;
  ofwCountry: string;
  ofwReturnDate: string;
  is4Ps: string;
  householdIdNo: string;
  preferredOccupation1: string;
  preferredOccupation2: string;
  workType: string;
  workLocation: string;
  preferredLocalAreas: string[];
  preferredOverseasCountries: string[];
  languageProficiency: Record<string, string[]>;
  currentlyInSchool: string;
  educationLevel: EducationLevel | "";
  course: string;
  yearGraduated: string;
  undergradLevelReached: string;
  undergradYearLastAttended: string;
  trainings: TrainingEntry[];
  eligibilities: EligibilityEntry[];
  licenses: LicenseEntry[];
  technicalTraining: string;
  otherSkills: string[];
  otherSkillsCustom: string;
  skills: string;
  companyName: string;
  position: string;
  experience: string;
  workExperiences: WorkExperienceEntry[];
  referredTo: string[];
  referredToOthers: string;
  applicationType: string;
  /** "Yes" | "No" | "" — set when the seeker has no Requirements/Documents to upload,
   *  so Section VIII can still count as fulfilled without an actual file. */
  noDocumentsDeclared: string;
}

export type ApplicationStatus =
  | "pending"
  | "checking"
  | "approved"
  | "waiting"
  | "hired"
  | "declined";

export interface ApplicationHistoryEntry {
  label: string;
  date: string;
}

export interface Application {
  id: number;
  vacancyId: number;
  status: ApplicationStatus;
  dateApplied: string;
  history: ApplicationHistoryEntry[];
  employerStatus: "" | "under_employer_review" | "shortlisted" | "interview" | "accepted_hired" | "not_selected";
  employerRemarks: string;
  /** Section 3: true when this application was created by PESO Staff via the Refer
   * Seeker function rather than the Seeker applying directly. */
  isStaffReferral?: boolean;
  referredBy?: string;
  referredAt?: string;
}

export interface StaffReferral {
  id: number;
  referredBy: string;
  status: "pending" | "accepted";
  createdAt: string;
  vacancy: Vacancy;
}

export interface AppNotification {
  id: number;
  message: string;
  date: string;
  read: boolean;
}

export interface MatchBreakdown {
  educationScore: number;
  skillsScore: number;
  experienceScore: number;
  totalScore: number;
}

/** A document the seeker has uploaded (metadata only — actual bytes live on the server). */
export interface DocumentMeta {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

export type UserRole = "job_seeker" | "employer" | "staff" | "admin";

export type VerificationStatus = "draft" | "pending_verification" | "returned_for_completion" | "verified" | "rejected" | "suspended";

export type VacancyStatus = "draft" | "pending_approval" | "approved" | "returned_for_completion" | "rejected" | "expired" | "closed";

export interface VerificationHistoryEntry {
  id: number;
  userEmail: string;
  userRole: string;
  previousStatus: string;
  newStatus: string;
  action: string;
  remarks: string;
  performedBy: string;
  performedByRole: string;
  createdAt: string;
}

export interface ActivityLogEntry {
  id: number;
  userEmail: string;
  userRole: string;
  action: string;
  relatedRecord: string;
  performedBy: string;
  performedByRole: string;
  remarks: string;
  createdAt: string;
}

/** The authenticated user record returned by the backend (JobSeeker profile + account info,
 *  plus the employer/staff/admin fields and the verification-workflow fields shared by every role). */
export interface AuthUser extends JobSeeker {
  isAdmin: boolean;
  role: UserRole;

  verificationStatus: VerificationStatus;
  verificationRemarks: string;
  verificationSubmittedAt: string;
  verificationReviewedAt: string;
  verificationReviewedBy: string;
  verificationAttempts: number;

  employerCompanyName: string;
  employerBusinessPermit: string;
  employerIndustry: string;
  employerAddress: string;
  employerContactPerson: string;
  employerContactNumber: string;
  employerDescription: string;

  /** NSRP Form 2 — Establishment Registration Form fields (Employer add-on) */
  employerBusinessName: string;
  employerTradeName: string;
  employerAcronym: string;
  employerTin: string;
  employerType: "" | "Public" | "Private";
  employerCategory: string;
  employerNatureOfWork: string;
  employerWorkforceSize: string;
  employerStreet: string;
  employerBarangay: string;
  employerMunicipality: string;
  employerProvince: string;
  employerOwnerName: string;
  employerPosition: string;
  employerTelephone: string;
  employerMobile: string;
  employerFax: string;
  employerEmail: string;
  employerSuspensionReason: string;
}
