import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../config.js";
import { computeMatchScore } from "../jobMatch.js";

let original;
let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  original = {
    enabled: CONFIG.ai.enabled,
    useAI: CONFIG.matching.useAI,
    url: CONFIG.ai.ollamaUrl,
    model: CONFIG.ai.model,
    resumePath: CONFIG.candidate.resumePath,
  };
  CONFIG.ai.enabled = true;
  CONFIG.matching.useAI = true;
  CONFIG.ai.ollamaUrl = "http://ollama.test/api/generate";
  CONFIG.ai.model = "local-test-model";
  CONFIG.candidate.resumePath = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  CONFIG.ai.enabled = original.enabled;
  CONFIG.matching.useAI = original.useAI;
  CONFIG.ai.ollamaUrl = original.url;
  CONFIG.ai.model = original.model;
  CONFIG.candidate.resumePath = original.resumePath;
});

test("job-match AI scoring remains on the configured Ollama endpoint", async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ response: "80" }) };
  };

  const result = await computeMatchScore({
    keySkills: ["Node.js"],
    role: "Backend Engineer",
    description: "Build Node.js services",
    fullText: "Build Node.js services",
  }, { title: "Backend Engineer" });

  assert.equal(request.url, "http://ollama.test/api/generate");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "local-test-model");
  assert.equal(body.stream, false);
  assert.equal(result.aiScore, 80);
  assert.equal(result.source, "keyword+ai");
});
