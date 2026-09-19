/**
 * AI fallback for screening questions that qaBank.js doesn't recognize.
 *
 * Uses a local, open-source Ollama model (default: llama3.2) so no resume
 * data or answers ever leave your machine. Every AI-generated answer is
 * cached to disk (answers-cache.json) keyed by the normalized question
 * text, so the same question is only ever sent to the model once — after
 * that it's an instant, deterministic lookup like the rest of the Q&A bank.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { getResumeText } from "./resumeText.js";

function normKey(q) {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

function loadCache() {
  try {
    if (fs.existsSync(CONFIG.files.qaCache)) {
      return JSON.parse(fs.readFileSync(CONFIG.files.qaCache, "utf8"));
    }
  } catch {
    // ignore corrupt cache, start fresh
  }
  return {};
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CONFIG.files.qaCache), { recursive: true });
  fs.writeFileSync(CONFIG.files.qaCache, JSON.stringify(cache, null, 2));
}

function appendReviewQueue(entry) {
  fs.mkdirSync(path.dirname(CONFIG.files.reviewQueue), { recursive: true });
  let list = [];
  try {
    if (fs.existsSync(CONFIG.files.reviewQueue)) {
      list = JSON.parse(fs.readFileSync(CONFIG.files.reviewQueue, "utf8"));
    }
  } catch {
    list = [];
  }
  list.push({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(CONFIG.files.reviewQueue, JSON.stringify(list, null, 2));
}

async function askOllama(question, field) {
  const resume = await getResumeText();
  const candidate = CONFIG.candidate;

  const optionsHint = field.options?.length
    ? `The answer MUST be exactly one of these options (copy the text exactly): ${JSON.stringify(
        field.options.filter((o) => !/select an option/i.test(o))
      )}.`
    : field.type === "number"
    ? "Answer with ONLY a number, no words or units."
    : "Answer in one short sentence or a single value — no explanations, no markdown.";

  const prompt = `You are helping ${candidate.name} fill out a Naukri.com job application screening question.
Answer the following question truthfully and concisely, based ONLY on the resume below.
If the resume doesn't contain the answer, give the most reasonable professional answer a backend/full-stack engineer with ${candidate.totalYearsExperience} years of experience would give.
${optionsHint}
Never mention that you are an AI. Output ONLY the answer value, nothing else.

RESUME:
"""
${resume || "(no resume text available)"}
"""

QUESTION: ${question}
ANSWER:`;

  const res = await fetch(CONFIG.ai.ollamaUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.ai.model,
      prompt,
      stream: false,
      options: { temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return (data.response || "").trim().replace(/^"|"$/g, "");
}

/**
 * Resolves an answer for a question qaBank.js couldn't handle.
 * Returns { answer, source: "ai-cache"|"ai" } or null if AI is disabled /
 * unavailable (in which case the job should be logged for manual review).
 */
export async function resolveWithAI(questionText, field = {}, jobContext = {}) {
  const key = normKey(questionText);
  const cache = loadCache();

  if (cache[key]) {
    return { answer: cache[key].answer, source: "ai-cache" };
  }

  if (!CONFIG.ai.enabled || !CONFIG.ai.autoAnswer) {
    appendReviewQueue({ question: questionText, field, job: jobContext, reason: "ai-disabled" });
    return null;
  }

  try {
    const answer = await askOllama(questionText, field);
    if (!answer) throw new Error("Empty response from model");

    cache[key] = {
      answer,
      questionText,
      field: { type: field.type, options: field.options },
      generatedAt: new Date().toISOString(),
      model: CONFIG.ai.model,
    };
    saveCache(cache);

    return { answer, source: "ai" };
  } catch (err) {
    appendReviewQueue({
      question: questionText,
      field,
      job: jobContext,
      reason: `ai-error: ${err.message}`,
    });
    return null;
  }
}

export default resolveWithAI;
