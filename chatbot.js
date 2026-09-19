/**
 * Handles Naukri's post-Apply screening chatbot.
 *
 * Two common variants (confirmed from live screenshots/recordings):
 *  A) Yes / No / Skip this question   (relocate / reside / interview availability)
 *  B) Free-text chat questions        ("What is your current CTC...",
 *     "How many years of experience do you have in X?") answered via a
 *     "Type message here..." input, one question at a time, each confirmed
 *     with a "Save" button.
 *
 * Soft Yes/No screening questions ALWAYS get Yes → higher shortlist odds.
 * Free-text questions are answered from the resume-based Q&A bank, with the
 * local AI model as fallback for anything qaBank.js doesn't recognize.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { matchKnownAnswer } from "./qaBank.js";
import { resolveWithAI } from "./aiFallback.js";
import { humanClick, humanType, humanDelay, sleep } from "./humanize.js";
import { logAnswer } from "./logger.js";

// Naukri's chat input isn't always a plain <input placeholder="Type message
// here...">  — cast a wide net (contenteditable divs, textareas, generic
// text inputs) so we don't silently mis-classify a text question as a
// Yes/No one just because the placeholder wording/markup differs.
const TEXT_INPUT_SELECTOR = [
  'input[placeholder*="type message" i]',
  'textarea[placeholder*="type message" i]',
  'input[placeholder*="type your" i]',
  'textarea[placeholder*="type your" i]',
  'input[placeholder*="enter your" i]',
  'textarea[placeholder*="enter your" i]',
  '[contenteditable="true"]',
  'input[type="text"]',
  "textarea",
].join(", ");

async function chatDebugScreenshot(page, tag) {
  try {
    const dir = path.join(CONFIG.profileDir, "..", "debug");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-chatbot-${tag}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  [CHATBOT] Saved screenshot: ${file}`);
  } catch {
    // best-effort only
  }
}

/**
 * The chatbot panel: any container with a visible "Save" button — covers
 * both the Yes/No variant and the free-text chat variant.
 */
function chatPanel(page) {
  return page
    .locator("div, section, aside")
    .filter({ has: page.getByRole("button", { name: /^save$/i }) })
    .last();
}

/** Finds the topmost visible panel with a Save button that looks like an
 * actual open question (Yes/No or free-text), returning both the panel and
 * a short diagnostic reason string for logging. */
async function findQuestionPanel(page) {
  const panels = page.locator("div, section, aside").filter({
    has: page.getByRole("button", { name: /^save$/i }),
  });
  const n = await panels.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const p = panels.nth(i);
    if (!(await p.isVisible().catch(() => false))) continue;
    const text = (await p.innerText().catch(() => "")).toLowerCase();
    const hasQuestion =
      /\?/.test(text) ||
      /skip this question/i.test(text) ||
      /relocat|resid|interview|available|f2f|willing|comfortable/i.test(text);
    const hasYesNo = /\byes\b/.test(text) && /\bno\b/.test(text);
    const hasTextInput = await findAnswerInput(p);
    if ((hasYesNo || hasTextInput) && hasQuestion) {
      return { panel: p, hasYesNo, hasTextInput: !!hasTextInput };
    }
  }
  return null;
}

async function isChatOpen(page) {
  return (await findQuestionPanel(page)) !== null;
}

async function getOpenPanel(page) {
  const found = await findQuestionPanel(page);
  return found ? found.panel : chatPanel(page);
}

/** In the free-text chat variant, several Q/A bubbles from earlier in the
 * conversation remain visible above the current one — grab the LAST
 * question-shaped sentence, since that's always the one still awaiting
 * an answer. */
async function readQuestion(panel) {
  const text = (await panel.innerText().catch(() => "")).replace(/[ \t]+/g, " ").trim();
  const matches = [...text.matchAll(/([^?\n]{5,280}\?)/g)];
  if (matches.length) return matches[matches.length - 1][1].trim();
  return text.slice(-200);
}

/** Returns the visible chat text input for the free-text variant, or null
 * if this is a Yes/No (button/radio-based) question. Radio-button panels
 * never contain a free-text field, so bail out early for those. */
async function findAnswerInput(panel) {
  const hasRadio = await panel
    .getByRole("radio")
    .count()
    .catch(() => 0);
  if (hasRadio) return null;

  const candidates = panel.locator(TEXT_INPUT_SELECTOR);
  const n = await candidates.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const el = candidates.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** Reads back whatever text currently sits in the input/contenteditable so
 * we can confirm typing actually landed instead of silently no-oping. */
async function readInputValue(el) {
  return el
    .evaluate((node) => {
      if ("value" in node) return node.value;
      return node.textContent;
    })
    .catch(() => null);
}

async function clickYes(page, panel) {
  const radio = panel.getByRole("radio", { name: /^yes$/i });
  if (await radio.count().catch(() => 0)) {
    await radio.first().check({ force: true }).catch(async () => {
      await humanClick(page, radio.first()).catch(() => radio.first().click({ force: true }));
    });
    return true;
  }

  const label = panel.locator("label").filter({ hasText: /^yes$/i });
  if (await label.count().catch(() => 0)) {
    await humanClick(page, label.first()).catch(() => label.first().click({ force: true }));
    return true;
  }

  const rows = panel.locator("div, li, span, button").filter({ hasText: /^yes$/i });
  const n = await rows.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const t = (await row.innerText().catch(() => "")).trim();
    if (/^yes$/i.test(t) && (await row.isVisible().catch(() => false))) {
      await humanClick(page, row).catch(() => row.click({ force: true }));
      return true;
    }
  }

  const exact = panel.getByText("Yes", { exact: true }).first();
  if (await exact.count().catch(() => 0)) {
    await exact.click({ force: true });
    return true;
  }
  return false;
}

async function clickSave(page, panel) {
  const saveBtn = panel.getByRole("button", { name: /^save$/i }).last();
  if (!(await saveBtn.count().catch(() => 0))) return false;

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const disabled = await saveBtn.isDisabled().catch(() => false);
    const ariaDisabled = (await saveBtn.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (!disabled && !ariaDisabled) break;
    await sleep(200);
  }

  // Take a little "breath" before saving — mirrors how a real person
  // briefly pauses after typing/selecting an answer before confirming it.
  await humanDelay(1000, 2000);

  await humanClick(page, saveBtn).catch(() => saveBtn.click({ force: true }));
  await humanDelay(800, 1600);
  return true;
}

async function answerCurrentQuestion(page, jobContext) {
  const panel = await getOpenPanel(page);
  if (!(await panel.isVisible().catch(() => false))) return false;

  const question = await readQuestion(panel);
  const textInput = await findAnswerInput(panel);
  console.log(`  [CHATBOT] Question: "${question}" (${textInput ? "free-text" : "yes/no"})`);

  if (textInput) {
    // Free-text chat question, e.g. "What is your current CTC and expected
    // annual CTC in INR?" or "How many years of experience do you have in
    // React?" — answered from the resume-based Q&A bank, falling back to
    // the local AI model for anything qaBank.js doesn't recognize.
    let answer = matchKnownAnswer(question, { type: "text" });
    let source = "qa-bank";
    if (answer == null) {
      console.log("  [CHATBOT] qaBank has no rule for this question — trying AI fallback...");
      const resolved = await resolveWithAI(question, { type: "text" }, jobContext);
      if (!resolved) {
        console.log("  [CHATBOT] No known/AI answer for free-text question — leaving for manual review.");
        await chatDebugScreenshot(page, "unanswerable-text-question");
        return false;
      }
      answer = resolved.answer;
      source = resolved.source;
    }

    logAnswer(jobContext, question || "(chatbot question)", answer, source);
    await humanType(page, textInput, String(answer));

    // Confirm the text actually landed — some widgets need a real
    // dispatched `input` event, which humanType provides via keyboard.type,
    // but verify anyway so a silent failure doesn't get logged as "applied".
    let landed = (await readInputValue(textInput)) || "";
    if (!landed.trim()) {
      console.log("  [CHATBOT] Typed text didn't register — retrying with locator.fill()...");
      await textInput.fill(String(answer)).catch(() => {});
      await sleep(300);
      landed = (await readInputValue(textInput)) || "";
    }
    console.log(`  [CHATBOT] Input now contains: "${landed.trim()}"`);
    if (!landed.trim()) {
      console.log("  [CHATBOT] Could not get any text into the input — leaving for manual review.");
      await chatDebugScreenshot(page, "text-input-empty-after-type");
      return false;
    }
  } else {
    // Yes/No screening question — soft bias toward "Yes" for shortlist odds.
    let answer = matchKnownAnswer(question, { type: "radio", options: ["Yes", "No"] }) || "Yes";
    if (/^no$/i.test(String(answer)) || /skip/i.test(String(answer))) answer = "Yes";

    logAnswer(jobContext, question || "(chatbot question)", answer, "qa-bank-yes");

    if (!(await clickYes(page, panel))) {
      console.log("  [CHATBOT] Could not click Yes option");
      await chatDebugScreenshot(page, "could-not-click-yes");
      return false;
    }
  }

  await humanDelay(
    CONFIG.limits.minDelayBetweenFormStepsMs,
    CONFIG.limits.maxDelayBetweenFormStepsMs
  );

  console.log("  [CHATBOT] Pausing briefly before Save...");
  if (!(await clickSave(page, panel))) {
    console.log("  [CHATBOT] Could not click Save");
    await chatDebugScreenshot(page, "could-not-click-save");
    return false;
  }
  console.log("  [CHATBOT] Save clicked.");
  return true;
}

/**
 * @returns {"none"|"completed"|"needs_review"}
 */
export async function handleScreeningQuestionsIfAny(page, jobContext) {
  // Some popups take a moment to animate in after clicking Apply — give it
  // a generous window before concluding there's no widget at all.
  const pollDeadline = Date.now() + 8000;
  let seen = false;
  while (Date.now() < pollDeadline) {
    if (await isChatOpen(page)) {
      seen = true;
      break;
    }
    await sleep(300);
  }
  if (!seen) return "none";

  console.log("  [CHATBOT] Screening question widget detected — answering...");
  await chatDebugScreenshot(page, "widget-detected");

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (!(await isChatOpen(page))) return "completed";

    const ok = await answerCurrentQuestion(page, jobContext);
    if (!ok) {
      console.log("  [CHATBOT] Failed to answer — leaving for manual review.");
      return "needs_review";
    }

    await humanDelay(600, 1200);
    if (!(await isChatOpen(page))) return "completed";
  }

  console.log("  [CHATBOT] Exceeded max steps — leaving for manual review.");
  return "needs_review";
}

export default handleScreeningQuestionsIfAny;
