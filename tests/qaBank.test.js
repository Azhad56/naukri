import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../config.js";
import { matchKnownAnswer } from "../qaBank.js";

test('relocation selects every offered city but excludes skip and negative choices', () => {
  assert.deepEqual(matchKnownAnswer('Please select the city you are currently residing or willing to relocate to', {
    type: 'checkbox', options: ['Bengaluru', 'Kolkata', 'Skip this question', 'None of the above', 'Not willing to relocate'],
  }), ['Bengaluru', 'Kolkata']);
  assert.deepEqual(matchKnownAnswer('Choose your preferred work locations', {
    type: 'checkbox', options: ['Kochi', 'All of the above'],
  }), ['All of the above']);
});

test('single city choices respect the control and current residence stays factual', () => {
  assert.equal(matchKnownAnswer('Select the city you are willing to relocate to', {
    type: 'radio', options: ['Kochi', 'Kolkata'],
  }), 'Kochi');
  const original = CONFIG.candidate.location;
  try {
    CONFIG.candidate.location = 'Pune';
    assert.deepEqual(matchKnownAnswer('Please select the city you are currently residing in', {
      type: 'checkbox', options: ['Pune', 'Kolkata'],
    }), ['Pune']);
  } finally {
    CONFIG.candidate.location = original;
  }
});

test("answers LWD and related joining-timeline questions from candidate guidance", async (t) => {
  const textQuestions = [
    "If yes, when is your LWD?",
    "What is your last working day?",
    "What is your last working date with your current employer?",
    "What is your notice period?",
    "How soon can you join?",
    "When can you start?",
  ];
  for (const question of textQuestions) {
    await t.test(question, () => {
      assert.equal(matchKnownAnswer(question, { type: "text" }), "Immediate");
    });
  }
  assert.equal(matchKnownAnswer("How many notice days do you have?", { type: "number" }), "0");
  assert.equal(
    matchKnownAnswer("Select your notice period", {
      type: "select",
      options: ["30 days", "Immediate", "60 days"],
    }),
    "Immediate"
  );
  assert.equal(
    matchKnownAnswer("Are you available to join immediately?", {
      type: "radio",
      options: ["Yes", "No"],
    }),
    "Yes"
  );
});

test("uses configured total experience for unlisted skills and related wording", () => {
  const years = String(CONFIG.candidate.totalYearsExperience);
  assert.equal(
    matchKnownAnswer("How many years of experience do you have in PHP?", { type: "text" }),
    years
  );
  assert.equal(
    matchKnownAnswer("How many years of C++ experience do you have?", { type: "number" }),
    years
  );
  assert.equal(
    matchKnownAnswer("Select your years of Rust experience", {
      type: "select",
      options: ["0-2 years", "3-5 years", "6-8 years"],
    }),
    "3-5 years"
  );
});

test("answers Yes for questions about AI coding-tool usage", () => {
  const questions = [
    "Have you used AI coding tools like GitHub Copilot, Claude Code, Cursor, Windsurf, or similar tools in your day-to-day development work?",
    "Do you use AI developer tools?",
    "Have you worked with Codeium or Tabnine?",
  ];
  for (const question of questions) {
    assert.equal(matchKnownAnswer(question, { type: "text" }), "Yes");
    assert.equal(
      matchKnownAnswer(question, { type: "radio", options: ["Yes", "No"] }),
      "Yes"
    );
  }
});

test("continues to answer Yes for relocation and residence variants", () => {
  const questions = [
    "Are you currently residing in Gurugram, Haryana or willing to relocate to Gurugram, Haryana?",
    "Are you living or willing to relocation to Gurgaon/Gurugram?",
    "Are you open to move to Noida?",
  ];
  for (const question of questions) {
    assert.equal(
      matchKnownAnswer(question, { type: "radio", options: ["Yes", "No"] }),
      "Yes"
    );
  }
});

test('handles supplied CTC, Instahyre-style profile, and factual residence questions', () => {
  const original = { ...CONFIG.candidate };
  try {
    Object.assign(CONFIG.candidate, { currentCtcLpa: 17, expectedCtcLpa: 19, dateOfBirth: '25/04/2000', location: 'Delhi', totalYearsExperience: 5, noticePeriodDays: 0 });
    assert.equal(matchKnownAnswer('What is your current CTC in INR?', { type: 'number' }), '1700000');
    assert.equal(matchKnownAnswer('How much annual salary are you expecting? (in LPA, e.g., 45)', { type: 'number' }), '19');
    assert.equal(matchKnownAnswer('Are you currently living in Kerala?', { type: 'radio', options: ['Yes', 'No'] }), 'No');
    assert.equal(matchKnownAnswer('How many years of experience do you have in Full stack?', { type: 'radio', options: ['<2 years', '2-5 years', '5-7 years'] }), '2-5 years');
    assert.equal(matchKnownAnswer('Date of Birth', { type: 'text' }), '25/04/2000');
    assert.equal(matchKnownAnswer('Are you currently serving notice period?', { type: 'radio', options: ['Yes', 'No'] }), 'No');
  } finally { Object.assign(CONFIG.candidate, original); }
});
