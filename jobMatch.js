/**
 * Computes how well a job posting matches the candidate's resume/skills
 * BEFORE spending an application on it (i.e. before ever clicking Apply).
 *
 * Two signals, combined:
 *  1. Deterministic keyword overlap between the job's "Key Skills" chips
 *     (falling back to the full job text) and the candidate's configured
 *     skill list — always available, zero external dependencies, instant.
 *  2. Optional AI judgment (local Ollama model) reading the full job
 *     description against the resume text for a more holistic percentage.
 *     Skipped gracefully if Ollama is disabled/unreachable.
 *
 * Jobs scoring below CONFIG.matching.minMatchPercent are skipped.
 */
import { CONFIG } from "./config.js";
import { getResumeText } from "./resumeText.js";

function normWord(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9+.#]/g, "");
}

/** Grabs the text between a heading and the next heading, using Naukri's
 * consistent section labels rather than fragile/churning class names. */
function extractSection(text, startRe, endRe) {
  const startMatch = text.match(startRe);
  if (!startMatch) return "";
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = text.slice(startIdx);
  const endMatch = endRe ? rest.match(endRe) : null;
  const endIdx = endMatch ? endMatch.index : Math.min(rest.length, 4000);
  return rest.slice(0, endIdx).trim();
}

/** Reads Job highlights / Job description / Role / Key Skills straight off
 * the job detail page's visible text — resilient to Naukri's frequent
 * class-name churn since these section headings themselves stay stable. */
export async function extractJobDetails(page) {
  const text = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const highlights = extractSection(text, /Job highlights/i, /Job description/i);
  const description = extractSection(
    text,
    /Job description/i,
    /(\bRole:|Skills highlighted|Key [Ss]kills|About company|Company Profile)/i
  );
  const roleMatch = text.match(/\bRole:\s*([^\n]+)/i);
  const keySkillsSection = extractSection(
    text,
    /Skills highlighted[^\n]*|Key [Ss]kills/i,
    /(About company|Company Profile|About Recruiter|Similar Jobs|Salary insights|People also viewed|Benefits\s*&\s*Perks|$)/i
  );
  const keySkills = keySkillsSection
    .split(/\n|,|·|•/)
    .map((s) => s.replace(/^[☆★*]\s*/, "").trim())
    .filter((s) => s && s.length <= 40);

  const fullText = [highlights, description, roleMatch?.[1] || "", keySkillsSection]
    .filter(Boolean)
    .join(" ");

  return {
    highlights,
    description,
    role: roleMatch ? roleMatch[1].trim() : "",
    keySkills,
    fullText: fullText || text.slice(0, 4000),
  };
}

/** Deterministic keyword-overlap score (0-100) — always available, no
 * network calls. Uses the job's Key Skills chips as the denominator when
 * present (most reliable), falling back to scanning the full job text. */
function computeKeywordMatchScore(jobDetails, candidateSkillNames) {
  const candidateTokens = candidateSkillNames.map(normWord).filter(Boolean);
  if (!candidateTokens.length) return 0;

  let denominatorTokens = jobDetails.keySkills.map(normWord).filter(Boolean);
  if (!denominatorTokens.length) {
    denominatorTokens = [
      ...new Set(jobDetails.fullText.toLowerCase().match(/[a-z][a-z0-9+.#]{1,20}/g) || []),
    ];
  }
  if (!denominatorTokens.length) return 0;

  const isMatch = (tok) =>
    candidateTokens.some(
      (c) => c === tok || (tok.length > 2 && c.length > 2 && (c.includes(tok) || tok.includes(c)))
    );

  const matchedCount = denominatorTokens.filter(isMatch).length;
  return Math.min(100, Math.round((matchedCount / denominatorTokens.length) * 100));
}

/** Optional AI judgment via local Ollama — a holistic read of the full job
 * text against the resume, returning a 0-100 percentage, or null if AI is
 * disabled/unreachable so the caller falls back to the keyword score. */
async function computeAIMatchScore(jobDetails, jobContext) {
  if (!CONFIG.ai.enabled) return null;

  try {
    const resume = await getResumeText();
    const prompt = `You are screening a job posting against a candidate's resume for an auto-apply bot.
Rate how well this candidate's resume matches the job's requirements on a scale of 0 to 100 (0 = no match at all, 100 = perfect match).
Weigh required skills and experience level most heavily.
Output ONLY the integer percentage — no words, no "%", no explanation.

RESUME:
"""
${resume || "(no resume text available)"}
"""

JOB TITLE: ${jobContext.title || ""}
JOB ROLE: ${jobDetails.role || ""}
KEY SKILLS: ${jobDetails.keySkills.join(", ")}
JOB DESCRIPTION:
"""
${(jobDetails.description || jobDetails.fullText).slice(0, 3000)}
"""

MATCH PERCENTAGE:`;

    const res = await fetch(CONFIG.ai.ollamaUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.ai.model,
        prompt,
        stream: false,
        options: { temperature: 0.1 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);

    const data = await res.json();
    const m = String(data.response || "").match(/\d{1,3}/);
    if (!m) return null;
    return Math.max(0, Math.min(100, parseInt(m[0], 10)));
  } catch (err) {
    console.log(`  [MATCH] AI scoring unavailable (${err.message}) — using keyword score only.`);
    return null;
  }
}

/**
 * @returns {{score: number, source: "keyword+ai"|"keyword", keywordScore: number, aiScore: number|null}}
 */
export async function computeMatchScore(jobDetails, jobContext = {}) {
  const candidateSkillNames = Object.keys(CONFIG.candidate.skills || {});
  const keywordScore = computeKeywordMatchScore(jobDetails, candidateSkillNames);
  const aiScore = CONFIG.matching.useAI ? await computeAIMatchScore(jobDetails, jobContext) : null;

  const score = aiScore == null ? keywordScore : Math.round((keywordScore + aiScore) / 2);

  return {
    score,
    source: aiScore == null ? "keyword" : "keyword+ai",
    keywordScore,
    aiScore,
  };
}

export default computeMatchScore;
