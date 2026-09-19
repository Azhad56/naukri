/**
 * Extracts and caches plain text from an optional resume PDF so it can be
 * used as grounding context for the AI fallback when answering unknown
 * screening questions. Naukri applications reuse the resume already
 * attached to your profile — this is only for smarter AI answers.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

let cached = null;

export async function getResumeText() {
  if (cached) return cached;

  if (!CONFIG.candidate.resumePath) return "";

  if (fs.existsSync(CONFIG.files.resumeText)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG.files.resumeText, "utf8"));
    if (saved?.text) {
      cached = saved.text;
      return cached;
    }
  }

  if (!fs.existsSync(CONFIG.candidate.resumePath)) return "";

  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const buffer = fs.readFileSync(CONFIG.candidate.resumePath);
  const data = await pdfParse(buffer);
  cached = data.text.replace(/\s+\n/g, "\n").trim();

  fs.mkdirSync(path.dirname(CONFIG.files.resumeText), { recursive: true });
  fs.writeFileSync(
    CONFIG.files.resumeText,
    JSON.stringify({ text: cached, extractedAt: new Date().toISOString() }, null, 2)
  );

  return cached;
}
