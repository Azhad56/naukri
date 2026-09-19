/**
 * Handles Naukri's post-Apply screening chatbot.
 *
 * Typical UI (confirmed from live screenshots):
 *  - Right-side panel with a chat bubble question ending in "?"
 *  - Radio cards: Yes / No / Skip this question
 *  - Footer "Save" button (disabled until an option is selected)
 *
 * Relocation / reside / willing / comfortable questions ALWAYS get Yes
 * so shortlist odds stay high.
 */
import { CONFIG } from "./config.js";
import { matchKnownAnswer } from "./qaBank.js";
import { humanClick, humanDelay, sleep } from "./humanize.js";
import { logAnswer } from "./logger.js";

/** The chatbot panel — uniquely identified by "Skip this question". */
function chatPanel(page) {
  return page
    .locator('div, section, aside')
    .filter({ hasText: /skip this question/i })
    .filter({ hasText: /\?/ })
    .last();
}

async function isChatOpen(page) {
  const panel = chatPanel(page);
  return (await panel.count().catch(() => 0)) > 0 && (await panel.isVisible().catch(() => false));
}

async function readQuestion(panel) {
  const text = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const m = text.match(/((?:Are you|Do you|Have you|Would you|Can you|Will you)[^?]{5,280}\?)/i)
    || text.match(/([^?\n]{15,280}\?)/);
  return m ? m[1].trim() : text.slice(0, 200);
}

/**
 * Clicks the "Yes" option card inside the chatbot panel.
 * Naukri renders these as custom radio cards (not always native <input>).
 */
async function clickYes(page, panel) {
  // 1) Native radio with accessible name Yes
  const radio = panel.getByRole("radio", { name: /^yes$/i });
  if (await radio.count().catch(() => 0)) {
    await radio.first().check({ force: true }).catch(async () => {
      await humanClick(page, radio.first()).catch(() => radio.first().click({ force: true }));
    });
    return true;
  }

  // 2) Label wrapping Yes
  const label = panel.locator("label").filter({ hasText: /^yes$/i });
  if (await label.count().catch(() => 0)) {
    await humanClick(page, label.first()).catch(() => label.first().click({ force: true }));
    return true;
  }

  // 3) Clickable row/card whose visible text is exactly "Yes"
  //    (avoid matching "Skip this question" or longer sentences)
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

  // 4) Last resort: any exact "Yes" text inside the panel
  const exact = panel.getByText("Yes", { exact: true }).first();
  if (await exact.count().catch(() => 0)) {
    await exact.click({ force: true });
    return true;
  }
  return false;
}

async function clickSave(page, panel) {
  // Scope Save to the chatbot panel so we never hit the job-detail "Save" bookmark.
  const saveBtn = panel.getByRole("button", { name: /^save$/i }).last();
  if (!(await saveBtn.count().catch(() => 0))) return false;

  // Save starts disabled until an option is selected — wait for it to enable.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const disabled = await saveBtn.isDisabled().catch(() => false);
    const ariaDisabled = (await saveBtn.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (!disabled && !ariaDisabled) break;
    await sleep(200);
  }

  await humanClick(page, saveBtn).catch(() => saveBtn.click({ force: true }));
  await humanDelay(800, 1600);
  return true;
}

async function answerCurrentQuestion(page, jobContext) {
  const panel = chatPanel(page);
  if (!(await panel.isVisible().catch(() => false))) return false;

  const question = await readQuestion(panel);
  // Always Yes for relocate / reside / soft screens — and for any Yes/No
  // chatbot question by default (shortlist bias).
  let answer = matchKnownAnswer(question, { type: "radio", options: ["Yes", "No"] }) || "Yes";
  if (/^no$/i.test(String(answer)) || /skip/i.test(String(answer))) answer = "Yes";

  logAnswer(jobContext, question || "(chatbot question)", answer, "qa-bank-yes");

  const ok = await clickYes(page, panel);
  if (!ok) {
    console.log("  [CHATBOT] Could not click Yes option");
    return false;
  }
  await humanDelay(
    CONFIG.limits.minDelayBetweenFormStepsMs,
    CONFIG.limits.maxDelayBetweenFormStepsMs
  );

  const saved = await clickSave(page, panel);
  if (!saved) {
    console.log("  [CHATBOT] Could not click Save");
    return false;
  }
  return true;
}

/**
 * @returns {"none"|"completed"|"needs_review"}
 */
export async function handleScreeningQuestionsIfAny(page, jobContext) {
  const pollDeadline = Date.now() + 5000;
  let seen = false;
  while (Date.now() < pollDeadline) {
    if (await isChatOpen(page)) {
      seen = true;
      break;
    }
    await sleep(300);
  }
  if (!seen) return "none";

  console.log("  [CHATBOT] Screening question widget detected — answering Yes...");

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
