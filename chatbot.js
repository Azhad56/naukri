/**
 * Handles Naukri's post-Apply screening chatbot.
 *
 * Two common variants (confirmed from live screenshots):
 *  A) Yes / No / Skip this question  (relocate / reside)
 *  B) Yes / No only                   (interview availability, F2F, etc.)
 *
 * Soft screening questions ALWAYS get Yes → higher shortlist odds.
 */
import { CONFIG } from "./config.js";
import { matchKnownAnswer } from "./qaBank.js";
import { humanClick, humanDelay, sleep } from "./humanize.js";
import { logAnswer } from "./logger.js";

/**
 * The chatbot panel. Prefer the "Skip this question" variant when present;
 * otherwise match a panel that has both Yes + No option cards and a Save button.
 */
function chatPanel(page) {
  const withSkip = page
    .locator("div, section, aside")
    .filter({ hasText: /skip this question/i })
    .filter({ hasText: /\?/ });
  const withYesNoSave = page
    .locator("div, section, aside")
    .filter({ has: page.getByRole("button", { name: /^save$/i }) })
    .filter({ hasText: /^yes$/i })
    .filter({ hasText: /^no$/i });

  // Prefer skip-variant if visible, else yes/no+save panel
  return withSkip.or(withYesNoSave).last();
}

async function isChatOpen(page) {
  // Fast path: Save button near Yes/No options (chatbot footer, not bookmark)
  const panels = page.locator("div, section, aside").filter({
    has: page.getByRole("button", { name: /^save$/i }),
  });
  const n = await panels.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const p = panels.nth(i);
    if (!(await p.isVisible().catch(() => false))) continue;
    const text = (await p.innerText().catch(() => "")).toLowerCase();
    const hasYes = /\byes\b/.test(text);
    const hasNo = /\bno\b/.test(text);
    const hasQuestion =
      /\?/.test(text) ||
      /skip this question/i.test(text) ||
      /relocat|resid|interview|available|f2f|willing|comfortable/i.test(text);
    if (hasYes && hasNo && hasQuestion) return true;
  }
  return false;
}

async function getOpenPanel(page) {
  const panels = page.locator("div, section, aside").filter({
    has: page.getByRole("button", { name: /^save$/i }),
  });
  const n = await panels.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const p = panels.nth(i);
    if (!(await p.isVisible().catch(() => false))) continue;
    const text = (await p.innerText().catch(() => "")).toLowerCase();
    if (/\byes\b/.test(text) && /\bno\b/.test(text)) return p;
  }
  return chatPanel(page);
}

async function readQuestion(panel) {
  const text = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const m =
    text.match(
      /((?:Are you|Do you|Have you|Would you|Can you|Will you|Should be)[^?]{5,280}\??)/i
    ) || text.match(/([^?\n]{15,280}\?)/);
  return m ? m[1].trim() : text.slice(0, 200);
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

  await humanClick(page, saveBtn).catch(() => saveBtn.click({ force: true }));
  await humanDelay(800, 1600);
  return true;
}

async function answerCurrentQuestion(page, jobContext) {
  const panel = await getOpenPanel(page);
  if (!(await panel.isVisible().catch(() => false))) return false;

  const question = await readQuestion(panel);
  let answer = matchKnownAnswer(question, { type: "radio", options: ["Yes", "No"] }) || "Yes";
  if (/^no$/i.test(String(answer)) || /skip/i.test(String(answer))) answer = "Yes";

  logAnswer(jobContext, question || "(chatbot question)", answer, "qa-bank-yes");

  if (!(await clickYes(page, panel))) {
    console.log("  [CHATBOT] Could not click Yes option");
    return false;
  }
  await humanDelay(
    CONFIG.limits.minDelayBetweenFormStepsMs,
    CONFIG.limits.maxDelayBetweenFormStepsMs
  );

  if (!(await clickSave(page, panel))) {
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
