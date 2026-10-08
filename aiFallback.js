/**
 * OpenAI fallback for screening questions that qaBank.js cannot answer.
 *
 * Job-match scoring deliberately remains on the local Ollama path in
 * jobMatch.js. This module sends candidate data to OpenAI only for an unknown
 * screening question and disables response storage for every request.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { CONFIG } from "./config.js";
import { logOpenAIUsage } from "./logger.js";
import { getResumeText } from "./resumeText.js";

const PROVIDER = "openai";
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["answered", "unknown"] },
    answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["status", "answer", "confidence"],
  additionalProperties: false,
};

let client;
let clientKey;

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function loadCache() {
  try {
    if (fs.existsSync(CONFIG.files.qaCache)) {
      return JSON.parse(fs.readFileSync(CONFIG.files.qaCache, "utf8"));
    }
  } catch {
    // Ignore a corrupt cache and rebuild it with validated OpenAI answers.
  }
  return {};
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CONFIG.files.qaCache), { recursive: true });
  fs.writeFileSync(CONFIG.files.qaCache, JSON.stringify(cache, null, 2));
}

function configuredFacts() {
  const candidate = CONFIG.candidate;
  return {
    name: candidate.name,
    email: candidate.email,
    phone: candidate.phone,
    totalYearsExperience: candidate.totalYearsExperience,
    location: candidate.location,
    willingToRelocate: candidate.willingToRelocate,
    willingToTravel: candidate.willingToTravel,
    requiresSponsorship: candidate.requiresSponsorship,
    noticePeriod: candidate.noticePeriod,
    noticePeriodDays: candidate.noticePeriodDays,
    currentCtcLpa: candidate.currentCtcLpa,
    expectedCtcLpa: candidate.expectedCtcLpa,
    highestEducation: candidate.highestEducation,
    educationCompleted: candidate.educationCompleted,
    skills: candidate.skills,
  };
}

function normalizedField(field) {
  return {
    type: field.type || "text",
    options: (field.options || []).map((option) => String(option).trim()).filter(Boolean),
  };
}

function cacheIdentity(question, field, model, facts, resume) {
  const groundingFingerprint = hash(JSON.stringify({ facts, resume }));
  const identity = {
    provider: PROVIDER,
    model,
    question: normalize(question),
    field: normalizedField(field),
    groundingFingerprint,
  };
  return { key: hash(JSON.stringify(identity)), groundingFingerprint };
}

function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({
      apiKey,
      timeout: CONFIG.openai.timeoutMs,
      maxRetries: 2,
    });
    clientKey = apiKey;
  }
  return client;
}

function safeError(error) {
  const status = error?.status ? `HTTP ${error.status}: ` : "";
  const message = String(error?.message || error || "Unknown OpenAI error")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .slice(0, 500);
  return `${status}${message}`;
}

function validateResult(result, field) {
  if (!result || result.status !== "answered") {
    return { ok: false, reason: "OpenAI could not find a grounded answer" };
  }
  const answer = String(result.answer || "").trim();
  if (!answer) return { ok: false, reason: "OpenAI returned an empty answer" };

  const normalized = normalizedField(field);
  if (normalized.options.length && !normalized.options.includes(answer)) {
    return {
      ok: false,
      reason: `OpenAI answer is not one of the available options: ${JSON.stringify(normalized.options)}`,
    };
  }
  if (normalized.type === "number" && !/^-?\d+(?:\.\d+)?$/.test(answer)) {
    return { ok: false, reason: "OpenAI returned a non-numeric answer for a numeric field" };
  }
  return { ok: true, answer, confidence: result.confidence };
}

function usageEntry(response, jobContext) {
  const usage = response.usage || {};
  return {
    provider: PROVIDER,
    purpose: "unknown-screening-question",
    model: response.model || CONFIG.openai.answerModel,
    responseId: response.id || null,
    jobUrl: jobContext.jobUrl || null,
    jobTitle: jobContext.title || null,
    inputTokens: usage.input_tokens ?? null,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

async function askOpenAI(question, field, jobContext, facts, resume, openaiClient) {
  const normalized = normalizedField(field);
  const optionsInstruction = normalized.options.length
    ? `Choose exactly one option, preserving its text exactly: ${JSON.stringify(normalized.options)}.`
    : normalized.type === "number"
      ? "The answer must contain only a number, with no words or units."
      : "Keep the answer to one short sentence or a single value.";

  const response = await openaiClient.responses.create({
    model: CONFIG.openai.answerModel,
    store: false,
    reasoning: { effort: CONFIG.openai.reasoningEffort },
    max_output_tokens: 300,
    instructions: `You answer a single Naukri job-application screening question for the candidate.
Use only the supplied candidate facts and resume. Never invent skills, years of experience, salary, qualifications, availability, or personal information.
If the supplied information does not support an answer, set status to "unknown", answer to an empty string, and confidence to "low".
If it does support an answer, set status to "answered" and return only the concise value the form needs.
${optionsInstruction}`,
    input: `CANDIDATE FACTS:\n${JSON.stringify(facts)}\n\nRESUME:\n${resume || "(no resume supplied)"}\n\nFIELD TYPE: ${normalized.type}\nAVAILABLE OPTIONS: ${JSON.stringify(normalized.options)}\nQUESTION: ${question}`,
    text: {
      format: {
        type: "json_schema",
        name: "screening_answer",
        description: "A grounded answer to one job-application screening question.",
        strict: true,
        schema: ANSWER_SCHEMA,
      },
    },
  });

  logOpenAIUsage(usageEntry(response, jobContext));
  if (response.status && response.status !== "completed") {
    throw new Error(`OpenAI response ended with status ${response.status}`);
  }
  if (!response.output_text) throw new Error("OpenAI returned no structured output");
  return JSON.parse(response.output_text);
}

/**
 * Returns {answer, source, confidence} when OpenAI produces a validated,
 * grounded answer. Returns {answer: null, source, error} for manual review.
 * The optional dependencies argument is used by offline tests only.
 */
export async function resolveWithAI(questionText, field = {}, jobContext = {}, dependencies = {}) {
  if (!CONFIG.ai.enabled || !CONFIG.ai.autoAnswer) {
    return { answer: null, source: "openai", error: "AI answering is disabled" };
  }

  const apiKey = dependencies.apiKey ?? CONFIG.openai.apiKey;
  if (!apiKey) {
    return {
      answer: null,
      source: "openai",
      error: "OPENAI_API_KEY is missing; unknown screening questions require manual review",
    };
  }

  try {
    const facts = dependencies.facts ?? configuredFacts();
    const resume = dependencies.resume ?? await getResumeText();
    const model = CONFIG.openai.answerModel;
    const { key, groundingFingerprint } = cacheIdentity(questionText, field, model, facts, resume);
    const cache = loadCache();
    const cached = cache[key];
    if (
      cached?.provider === PROVIDER &&
      cached?.model === model &&
      cached?.groundingFingerprint === groundingFingerprint
    ) {
      const validated = validateResult(cached.result, field);
      if (validated.ok) {
        return { answer: validated.answer, confidence: validated.confidence, source: "openai-cache" };
      }
    }

    const openaiClient = dependencies.client ?? getClient(apiKey);
    const result = await askOpenAI(questionText, field, jobContext, facts, resume, openaiClient);
    const validated = validateResult(result, field);
    if (!validated.ok) return { answer: null, source: "openai", error: validated.reason };

    cache[key] = {
      provider: PROVIDER,
      model,
      questionText,
      field: normalizedField(field),
      groundingFingerprint,
      result: {
        status: "answered",
        answer: validated.answer,
        confidence: validated.confidence,
      },
      generatedAt: new Date().toISOString(),
    };
    saveCache(cache);

    return {
      answer: validated.answer,
      confidence: validated.confidence,
      source: "openai",
    };
  } catch (error) {
    return { answer: null, source: "openai", error: safeError(error) };
  }
}

export default resolveWithAI;
