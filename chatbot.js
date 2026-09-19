/**
 * Handles Naukri's optional post-"Apply" screening-question chatbot.
 *
 * Typical UI (confirmed from live screenshots):
 *  - A chat bubble with the question text ending in "?"
 *  - Radio options: Yes / No / Skip this question
 *  - A "Save" button at the bottom
 *
 * Soft screening questions (relocate / reside / comfortable / willing) always
 * get Yes to maximize shortlist probability.
 */
import { CONFIG } from "./config.js";
import { matchKnownAnswer, SKIP } from "./qaBank.js";
import { resolveWithAI } from "./aiFallback.js";
import { humanClick, humanDelay, sleep } from "./humanize.js";
import { logAnswer } from "./logger.js";

function widgetLocator(page) {
  return page
    .locator(
      [
        'div[role="dialog"]',
        '[class*="chatbot" i]',
        '[class*="chat-bot" i]',
        '[id*="chatbot" i]',
        '[class*="bot" i]:has-text("Save")',
        '[class*="drawer" i]:has(input), [class*="drawer" i]:has(select)',
      ].join(", ")
    )
    .filter({ hasNotText: /applied to/i })
    .last();
}

async function isWidgetOpen(page) {
  // Prefer detecting by the Save button that appears in the chatbot footer —
  // more reliable than dialog roles alone.
  const saveBtn = page.getByRole("button", { name: /^save$/i });
  if ((await saveBtn.count().catch(() => 0)) && (await saveBtn.last().isVisible().catch(() => false))) {
    // Make sure it's the chatbot save, not the job-detail "Save" bookmark.
    const nearbyQuestion = page.locator("text=/\\?$/").last();
    if (await nearbyQuestion.isVisible().catch(() => false)) return true;
  }
  const widget = widgetLocator(page);
  return (await widget.count().catch(() => 0)) > 0 && (await widget.isVisible().catch(() => false));
}

/** Pulls the latest chat-bubble question (text ending with "?"). */
async function readLatestQuestion(page) {
  const candidates = page.locator(
    'div[role="dialog"] *, [class*="chat" i] *, [class*="bot" i] *'
  );
  const texts = await candidates.allInnerTexts().catch(() => []);
  const questions = texts
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 10 && t.length < 400 && /\?$/.test(t) && !/^yes$|^no$/i.test(t));
  // Prefer the longest match that looks like a full sentence question
  if (!questions.length) {
    // Broader fallback: any visible "?" text on the page near Save
    const broader = await page.locator("body").innerText().catch(() => "");
    const m = broader.match(/([^\n?]{15,300}\?)/g);
    if (m?.length) return m[m.length - 1].trim();
    return "";
  }
  return questions[questions.length - 1];
}

/**
 * Clicks a Yes/No style option by visible text. Naukri's chatbot often uses
 * custom radio markup (label/div) rather than bare <input type="radio">.
 */
async function clickOptionByText(page, label) {
  const scope = page.locator('div[role="dialog"], [class*="chat" i], [class*="bot" i]').last();
  const byRole = scope.getByRole("radio", { name: new RegExp(`^${label}$`, "i") });
  if (await byRole.count().catch(() => 0)) {
    await humanClick(page, byRole.first()).catch(() => byRole.first().click({ force: true }));
    return true;
  }
  const byLabel = scope.locator(`label:has-text("${label}"), span:has-text("${label}"), div:has-text("${label}")`)
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, "i") });
  if (await byLabel.count().catch(() => 0)) {
    await humanClick(page, byLabel.first()).catch(() => byLabel.first().click({ force: true }));
    return true;
  }
  // Absolute last resort: page-level exact text
  const exact = page.getByText(label, { exact: true }).last();
  if (await exact.isVisible().catch(() => false)) {
    await humanClick(page, exact).catch(() => exact.click({ force: true }));
    return true;
  }
  return false;
}

async function clickSave(page) {
  const saveBtn = page.getByRole("button", { name: /^save$/i }).last();
  if (await saveBtn.count().catch(() => 0)) {
    await humanClick(page, saveBtn).catch(() => saveBtn.click({ force: true }));
    await humanDelay(800, 1600);
    return true;
  }
  return false;
}

async function answerYesNoChat(page, jobContext) {
  const question = await readLatestQuestion(page);
  if (!question) return false;

  // Always Yes for soft screening (relocate / reside / comfortable / etc.)
  // and for any Yes/No chatbot question by default — "No" tanks shortlist odds.
  let answer = matchKnownAnswer(question, { type: "radio", options: ["Yes", "No"] });
  let source = "qa-bank";

  if (answer === SKIP) return true;

  if (answer == null) {
    // Default Yes for any chatbot Yes/No question rather than risking "No" from AI
    const hasYes = await page.getByText("Yes", { exact: true }).count().catch(() => 0);
    const hasNo = await page.getByText("No", { exact: true }).count().catch(() => 0);
    if (hasYes && hasNo) {
      answer = "Yes";
      source = "default-yes";
    } else {
      const ai = await resolveWithAI(question, { type: "radio", options: ["Yes", "No"] }, jobContext);
      if (!ai) return false;
      answer = ai.answer;
      source = ai.source;
      // Force Yes if AI returned No on a soft screening question
      if (/^no$/i.test(String(answer)) && /relocat|resid|willing|comfortable|open to/i.test(question)) {
        answer = "Yes";
        source = "forced-yes";
      }
    }
  }

  // Never pick "Skip this question" or "No" when Yes is available for soft Qs
  if (/^no$/i.test(String(answer)) || /skip/i.test(String(answer))) {
    if (/relocat|resid|willing|comfortable|open to|hybrid|remote|wfh/i.test(question)) {
      answer = "Yes";
      source = "forced-yes";
    }
  }

  logAnswer(jobContext, question, answer, source);
  const clicked = await clickOptionByText(page, String(answer));
  if (!clicked && /^yes$/i.test(String(answer))) {
    // Try clicking the radio input next to Yes text
    await clickOptionByText(page, "Yes");
  }
  await humanDelay(
    CONFIG.limits.minDelayBetweenFormStepsMs,
    CONFIG.limits.maxDelayBetweenFormStepsMs
  );
  await clickSave(page);
  return true;
}

/**
 * @returns {"none"|"completed"|"needs_review"}
 */
export async function handleScreeningQuestionsIfAny(page, jobContext) {
  const pollDeadline = Date.now() + 5000;
  let seen = false;
  while (Date.now() < pollDeadline) {
    if (await isWidgetOpen(page)) {
      seen = true;
      break;
    }
    await sleep(300);
  }
  if (!seen) return "none";

  console.log("  [CHATBOT] Screening question widget detected — answering...");

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (!(await isWidgetOpen(page))) return "completed";

    // Primary path: Naukri Yes/No chatbot (relocate / reside / etc.)
    const ok = await answerYesNoChat(page, jobContext);
    if (!ok) {
      console.log("  [CHATBOT] Could not answer confidently — leaving for manual review.");
      return "needs_review";
    }

    await humanDelay(600, 1200);
    // If another question appears, loop; otherwise done
    if (!(await isWidgetOpen(page))) return "completed";
  }

  console.log("  [CHATBOT] Exceeded max steps — leaving for manual review.");
  return "needs_review";
}

export default handleScreeningQuestionsIfAny;
