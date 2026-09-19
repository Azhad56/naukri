import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

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

export function alreadyHandled(jobUrl) {
  const log = loadJson(CONFIG.files.appliedLog, []);
  return log.some((e) => e.jobUrl === jobUrl && (e.status === "applied" || e.status === "skipped"));
}

export function logResult(entry) {
  const log = loadJson(CONFIG.files.appliedLog, []);
  log.push({ ...entry, at: new Date().toISOString() });
  saveJson(CONFIG.files.appliedLog, log);
}

export function logAnswer(jobContext, question, answer, source) {
  console.log(`    [Q&A:${source}] "${question}" -> "${answer}"`);
}
