import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { cardPrefix } from "./pagination.js";

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // corrupt file — start fresh rather than crash the run
  }
  return fallback;
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function jobUrlKey(jobUrl) {
  try {
    const url = new URL(jobUrl, "https://www.naukri.com/");
    return `${url.origin}${url.pathname}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return String(jobUrl || "").trim().toLowerCase();
  }
}

/** Only completed applications are permanent. Skipped jobs must be checked
 * again because match settings, page CTAs, and screening support can change. */
export function alreadyHandled(jobUrl) {
  const log = loadJson(CONFIG.files.appliedLog, []);
  const key = jobUrlKey(jobUrl);
  return log.some((e) => e.status === "applied" && jobUrlKey(e.jobUrl) === key);
}

export function logResult(entry) {
  const log = loadJson(CONFIG.files.appliedLog, []);
  log.push({ ...entry, at: new Date().toISOString() });
  saveJson(CONFIG.files.appliedLog, log);
}

export function logAnswer(jobContext, question, answer, source, status = "filled") {
  console.log(`${cardPrefix(jobContext)}[Q&A:${source}:${status}] "${question}" -> "${answer}"`);
  const log = loadJson(CONFIG.files.qaLog, []);
  log.push({ ...jobContext, question, answer, source, status, at: new Date().toISOString() });
  saveJson(CONFIG.files.qaLog, log);
}

export function logOpenAIUsage(entry) {
  const log = loadJson(CONFIG.files.openaiUsage, []);
  log.push({ ...entry, at: new Date().toISOString() });
  saveJson(CONFIG.files.openaiUsage, log);
}
