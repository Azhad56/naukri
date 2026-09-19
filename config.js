/**
 * Central configuration for the Naukri automation.
 *
 * Personal / sensitive values come from .env (see .env.example).
 * Naukri password is never stored — login once via `npm run login`;
 * the session persists under data/chrome-profile/.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, requireEnv, envInt } from "./loadEnv.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envBool(key, fallback) {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  return /^(1|true|yes|y)$/i.test(v.trim());
}

function envList(key, fallback = []) {
  const v = process.env[key];
  if (!v || !v.trim()) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export const CONFIG = {
  profileDir: path.join(__dirname, "data", "chrome-profile"),
  channel: "chrome",
  headless: false,

  candidate: {
    name: requireEnv("CANDIDATE_NAME"),
    email: requireEnv("CANDIDATE_EMAIL"),
    phone: requireEnv("CANDIDATE_PHONE"),
    totalYearsExperience: envInt("TOTAL_YEARS_EXPERIENCE", 5),
    location: process.env.CANDIDATE_LOCATION || "",
    willingToRelocate: envBool("WILLING_TO_RELOCATE", true),
    willingToTravel: envBool("WILLING_TO_TRAVEL", true),
    requiresSponsorship: envBool("REQUIRES_SPONSORSHIP", false),
    noticePeriod:
      process.env.NOTICE_PERIOD_TEXT || "Immediate / Currently serving notice period",
    noticePeriodDays: envInt("NOTICE_PERIOD_DAYS", 0),
    currentCtcLpa: envInt("CURRENT_CTC_LPA", 0),
    expectedCtcLpa: envInt("EXPECTED_CTC_LPA", 0),
    highestEducation: "Bachelor's Degree",
    educationCompleted: true,
    // Optional: only needed for the local AI fallback's grounding context.
    // Naukri applications reuse the resume already attached to your profile,
    // this automation never uploads a file during apply.
    resumePath: process.env.RESUME_PATH
      ? path.join(__dirname, process.env.RESUME_PATH)
      : null,
    skills: {
      "node.js": 5,
      node: 5,
      nodejs: 5,
      javascript: 5,
      typescript: 5,
      "express.js": 5,
      express: 5,
      nestjs: 3,
      "nest.js": 3,
      react: 5,
      "react.js": 5,
      reactjs: 5,
      graphql: 2,
      mongodb: 5,
      postgresql: 3,
      postgres: 3,
      mysql: 3,
      sql: 3,
      aws: 3,
      gcp: 2,
      kafka: 5,
      redis: 5,
      docker: 2,
      microservices: 5,
      python: 3,
    },
  },

  search: {
    keywords: envList("SEARCH_KEYWORDS", [
      "Node.js Developer",
      "Backend Developer",
      "Full Stack Developer",
    ]),
    // Naukri's experience dropdown, e.g. "4" for "4 years". Leave "" to skip.
    experienceYears: process.env.SEARCH_EXPERIENCE_YEARS || "",
    location: process.env.SEARCH_LOCATION || "",
    // Freshness filter label as shown in the "Freshness" dropdown, e.g.
    // "Last 3 days", "Last 7 days", "Last 15 days". Empty = don't filter.
    freshness: process.env.SEARCH_FRESHNESS || "Last 3 days",
    // Sort dropdown label: "Date" or "Recommended". Naukri defaults to
    // Recommended; we switch to Date for the freshest results.
    sortBy: process.env.SEARCH_SORT_BY || "Date",
    // Jobs whose CTA reads "Apply on company site" redirect off Naukri —
    // always skipped regardless of this flag; kept for clarity/logging only.
    skipCompanySiteApply: true,
  },

  limits: {
    maxApplicationsPerRun: envInt("MAX_APPLICATIONS_PER_RUN", 15),
    maxApplicationsPerKeyword: envInt("MAX_APPLICATIONS_PER_KEYWORD", 8),
    maxPagesPerKeyword: envInt("MAX_PAGES_PER_KEYWORD", 5),
    minDelayBetweenJobsMs: 10_000,
    maxDelayBetweenJobsMs: 28_000,
    longBreakEvery: 5,
    longBreakMinMs: 60_000,
    longBreakMaxMs: 150_000,
    minDelayBetweenFormStepsMs: 1_200,
    maxDelayBetweenFormStepsMs: 3_500,
  },

  ai: {
    enabled: envBool("AI_ENABLED", true),
    provider: "ollama",
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434/api/generate",
    model: process.env.AI_MODEL || "llama3.2",
    autoAnswer: true,
  },

  files: {
    qaCache: path.join(__dirname, "data", "answers-cache.json"),
    appliedLog: path.join(__dirname, "data", "applied-log.json"),
    reviewQueue: path.join(__dirname, "data", "needs-review.json"),
    resumeText: path.join(__dirname, "data", "resume-text.json"),
  },
};

export default CONFIG;
