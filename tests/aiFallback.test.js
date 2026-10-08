import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "../config.js";
import { resolveWithAI } from "../aiFallback.js";

let tempDir;
let original;

function responseFor(result, overrides = {}) {
  return {
    id: "resp_test",
    model: CONFIG.openai.answerModel,
    status: "completed",
    output_text: JSON.stringify(result),
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 15,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 135,
    },
    ...overrides,
  };
}

function mockClient(result, overrides) {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (request) => {
        calls.push(request);
        if (result instanceof Error) throw result;
        return responseFor(result, overrides);
      },
    },
  };
}

function dependencies(client, overrides = {}) {
  return {
    client,
    apiKey: "test-key-not-real",
    resume: "PRIVATE RESUME CONTENT",
    facts: { skills: { node: 5 }, location: "Pune" },
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "naukri-openai-test-"));
  original = {
    cache: CONFIG.files.qaCache,
    usage: CONFIG.files.openaiUsage,
    enabled: CONFIG.ai.enabled,
    autoAnswer: CONFIG.ai.autoAnswer,
    model: CONFIG.openai.answerModel,
    key: CONFIG.openai.apiKey,
  };
  CONFIG.files.qaCache = path.join(tempDir, "answers-cache.json");
  CONFIG.files.openaiUsage = path.join(tempDir, "openai-usage.json");
  CONFIG.ai.enabled = true;
  CONFIG.ai.autoAnswer = true;
  CONFIG.openai.answerModel = "gpt-6.1-sol";
  CONFIG.openai.apiKey = "";
});

afterEach(() => {
  CONFIG.files.qaCache = original.cache;
  CONFIG.files.openaiUsage = original.usage;
  CONFIG.ai.enabled = original.enabled;
  CONFIG.ai.autoAnswer = original.autoAnswer;
  CONFIG.openai.answerModel = original.model;
  CONFIG.openai.apiKey = original.key;
  if (
    tempDir &&
    path.dirname(path.resolve(tempDir)) === path.resolve(os.tmpdir()) &&
    path.basename(tempDir).startsWith("naukri-openai-test-")
  ) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("uses Responses API structured output without storage and logs safe usage", async () => {
  const client = mockClient({ status: "answered", answer: "3", confidence: "high" });
  const result = await resolveWithAI(
    "How many years of experience do you have with GraphQL?",
    { type: "number" },
    { jobUrl: "https://example.test/job", title: "Engineer" },
    dependencies(client)
  );

  assert.deepEqual(result, { answer: "3", confidence: "high", source: "openai" });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, "gpt-6.1-sol");
  assert.equal(client.calls[0].store, false);
  assert.deepEqual(client.calls[0].reasoning, { effort: "low" });
  assert.equal(client.calls[0].text.format.type, "json_schema");
  assert.equal(client.calls[0].text.format.strict, true);

  const usageText = fs.readFileSync(CONFIG.files.openaiUsage, "utf8");
  assert.doesNotMatch(usageText, /PRIVATE RESUME CONTENT|test-key-not-real|CANDIDATE FACTS/);
  const usage = JSON.parse(usageText).at(-1);
  assert.equal(usage.model, "gpt-6.1-sol");
  assert.equal(usage.purpose, "unknown-screening-question");
  assert.equal(usage.inputTokens, 120);
  assert.equal(usage.cachedInputTokens, 20);
  assert.equal(usage.outputTokens, 15);
  assert.equal(usage.reasoningTokens, 5);
});

test("reuses only provider/model/options/context-scoped OpenAI cache entries", async () => {
  const client = mockClient({ status: "answered", answer: "Yes", confidence: "medium" });
  const base = dependencies(client);
  const question = "Can you work from Gurgaon?";
  const field = { type: "radio", options: ["Yes", "No"] };

  assert.equal((await resolveWithAI(question, field, {}, base)).source, "openai");
  assert.equal((await resolveWithAI(question, field, {}, base)).source, "openai-cache");
  assert.equal(client.calls.length, 1);

  await resolveWithAI(question, { type: "radio", options: ["Yes", "No", "Maybe"] }, {}, base);
  assert.equal(client.calls.length, 2);

  await resolveWithAI(question, field, {}, dependencies(client, { facts: { skills: { node: 4 } } }));
  assert.equal(client.calls.length, 3);

  await resolveWithAI(question, field, {}, dependencies(client, { resume: "UPDATED PRIVATE RESUME" }));
  assert.equal(client.calls.length, 4);

  CONFIG.openai.answerModel = "gpt-6.1-sol-test-variant";
  await resolveWithAI(question, field, {}, base);
  assert.equal(client.calls.length, 5);

  const cacheText = fs.readFileSync(CONFIG.files.qaCache, "utf8");
  assert.doesNotMatch(cacheText, /PRIVATE RESUME CONTENT|test-key-not-real/);
  assert.match(cacheText, /"provider": "openai"/);
});

test("ignores legacy Ollama cache records", async () => {
  fs.writeFileSync(CONFIG.files.qaCache, JSON.stringify({
    "unknown question?": { answer: "legacy", model: "llama3.2" },
  }));
  const client = mockClient({ status: "answered", answer: "new", confidence: "high" });
  const result = await resolveWithAI("Unknown question?", { type: "text" }, {}, dependencies(client));
  assert.equal(result.answer, "new");
  assert.equal(result.source, "openai");
  assert.equal(client.calls.length, 1);
});

test("routes unknown, invalid choice and invalid number results to review", async (t) => {
  await t.test("unknown", async () => {
    const client = mockClient({ status: "unknown", answer: "", confidence: "low" });
    const result = await resolveWithAI("Unknown?", { type: "text" }, {}, dependencies(client));
    assert.equal(result.answer, null);
    assert.match(result.error, /grounded answer/);
  });
  await t.test("invalid choice", async () => {
    const client = mockClient({ status: "answered", answer: "Maybe", confidence: "low" });
    const result = await resolveWithAI("Relocate?", { type: "radio", options: ["Yes", "No"] }, {}, dependencies(client));
    assert.equal(result.answer, null);
    assert.match(result.error, /available options/);
  });
  await t.test("invalid number", async () => {
    const client = mockClient({ status: "answered", answer: "three years", confidence: "high" });
    const result = await resolveWithAI("Years?", { type: "number" }, {}, dependencies(client));
    assert.equal(result.answer, null);
    assert.match(result.error, /non-numeric/);
  });
});

test("accepts an exact OpenAI answer for a screening dropdown", async () => {
  const client = mockClient({ status: "answered", answer: "3-5 years", confidence: "high" });
  const result = await resolveWithAI(
    "Select your relevant experience",
    { type: "select", options: ["0-2 years", "3-5 years", "More than 5 years"] },
    {},
    dependencies(client)
  );
  assert.equal(result.answer, "3-5 years");
  assert.equal(result.source, "openai");
  assert.equal(client.calls.length, 1);
});

test("handles missing key, refusal-like output and API errors without exposing secrets", async (t) => {
  await t.test("missing key", async () => {
    const client = mockClient({ status: "answered", answer: "Yes", confidence: "high" });
    const result = await resolveWithAI("Question?", {}, {}, { client, apiKey: "" });
    assert.equal(result.answer, null);
    assert.match(result.error, /OPENAI_API_KEY is missing/);
    assert.equal(client.calls.length, 0);
  });
  await t.test("no output", async () => {
    const client = mockClient({}, { output_text: "" });
    const result = await resolveWithAI("Question?", {}, {}, dependencies(client));
    assert.equal(result.answer, null);
    assert.match(result.error, /no structured output/);
  });
  await t.test("API failure is redacted", async () => {
    const error = Object.assign(new Error("request failed for sk-secret-value"), { status: 429 });
    const client = mockClient(error);
    const result = await resolveWithAI("Question?", {}, {}, dependencies(client));
    assert.equal(result.answer, null);
    assert.match(result.error, /HTTP 429/);
    assert.doesNotMatch(result.error, /sk-secret-value/);
  });
  await t.test("timeout", async () => {
    const client = mockClient(new Error("Request timed out"));
    const result = await resolveWithAI("Question?", {}, {}, dependencies(client));
    assert.equal(result.answer, null);
    assert.match(result.error, /timed out/);
  });
});
