import type { EducationLevel, JobSeeker, MatchBreakdown, Vacancy } from "./types";

/** Ordinal ranking so we can compare "how far" a seeker's education is from a job's requirement. */
const EDUCATION_RANK: Record<EducationLevel, number> = {
  Elementary: 1,
  Secondary: 2,
  "Senior High": 3,
  Tertiary: 4,
  "Graduate Studies": 5,
  "Post-graduate": 6,
};

const WEIGHTS = {
  education: 0.4,
  skills: 0.35,
  experience: 0.25,
};

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Education Score: 100 if the seeker meets or exceeds the job's minimum education level,
 * otherwise scaled down proportionally to how close they are to it.
 */
export function educationScore(seeker: JobSeeker, job: Vacancy): number {
  if (!seeker.educationLevel) return 0;
  const seekerRank = EDUCATION_RANK[seeker.educationLevel];
  const requiredRank = EDUCATION_RANK[job.minEducationLevel];
  if (seekerRank >= requiredRank) return 100;
  return clamp((seekerRank / requiredRank) * 100);
}

/**
 * Skills Score: percentage of the job's required skill keywords found (as substrings)
 * across the seeker's skills summary, checked "other skills", and technical training.
 */
export function skillsScore(seeker: JobSeeker, job: Vacancy): number {
  if (job.requiredSkills.length === 0) return 100;

  const seekerSkillsText = [
    seeker.skills,
    seeker.otherSkills.join(", "),
    seeker.technicalTraining,
    seeker.preferredOccupation1,
    seeker.preferredOccupation2,
  ]
    .join(" ")
    .toLowerCase();

  const matched = job.requiredSkills.filter((skill) => seekerSkillsText.includes(skill.toLowerCase()));

  return clamp((matched.length / job.requiredSkills.length) * 100);
}

/** Pulls a rough "years of experience" number out of the seeker's free-text experience summary. */
function extractYearsOfExperience(experienceText: string): number {
  if (!experienceText) return 0;
  const match = experienceText.match(/(\d+(?:\.\d+)?)\s*\+?\s*(year|yr)/i);
  if (match) return parseFloat(match[1]);
  // If they described a role/company but gave no explicit duration, credit partial experience.
  return experienceText.trim().length > 0 ? 0.5 : 0;
}

/**
 * Experience Score: 100 if the seeker's estimated years of experience meets or exceeds
 * the job's minimum; otherwise scaled proportionally. Jobs that require no experience
 * always score 100 (nothing to be short of).
 */
export function experienceScore(seeker: JobSeeker, job: Vacancy): number {
  if (job.minExperienceYears <= 0) return 100;
  const years = extractYearsOfExperience(seeker.experience);
  if (years >= job.minExperienceYears) return 100;
  return clamp((years / job.minExperienceYears) * 100);
}

/**
 * Match Score = (Education Score × 40%) + (Skills Score × 35%) + (Experience Score × 25%)
 */
export function computeMatchScore(seeker: JobSeeker | null, job: Vacancy): MatchBreakdown {
  if (!seeker) {
    return { educationScore: 0, skillsScore: 0, experienceScore: 0, totalScore: 0 };
  }
  const edu = educationScore(seeker, job);
  const skl = skillsScore(seeker, job);
  const exp = experienceScore(seeker, job);
  const total = edu * WEIGHTS.education + skl * WEIGHTS.skills + exp * WEIGHTS.experience;
  return {
    educationScore: Math.round(edu),
    skillsScore: Math.round(skl),
    experienceScore: Math.round(exp),
    totalScore: Math.round(total),
  };
}

export function matchTier(score: number): "high" | "mid" | "low" {
  if (score >= 75) return "high";
  if (score >= 45) return "mid";
  return "low";
}
