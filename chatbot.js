/**
 * Handles Naukri's optional post-"Apply" screening questions.
 *
 * For many jobs, clicking "Apply" instantly shows an "Applied to X"
 * confirmation with no further input. For others, Naukri shows a
 * chatbot-style "quick questions" widget (radio choices, dropdowns, or
 * free-text) before the application is actually submitted.
 *
 * IMPORTANT: the recorded walkthrough this automation was built from never
 * triggered this widget, so the selectors below are written defensively —
 * broad, role/text-based, and generic — rather than tied to exact class
 * names. If Naukri shows a question flow with different markup on your
 * account, watch the console output (`[CHATBOT] ...` lines) on the first
 * real run and tighten these selectors as needed.
 */
import { CONFIG } from "./config.js";
import { matchKnownAnswer, SKIP } from "./qaBank.js";
import { resolveWithAI } from "./aiFallback.js";
import { humanClick, humanType, humanDelay, sleep } from "./humanize.js";
import { logAnswer } from "./logger.js";

/** Generic locator for any question/chat widget Naukri might overlay after Apply. */
function widgetLocator(page) {
  return page
    .locator(
      [
        'div[role="dialog"]',
        '[class*="chatbot" i]',
        '[class*="chat-bot" i]',
        '[id*="chatbot" i]',
        '[class*="drawer" i]:has(input), [class*="drawer" i]:has(select)',
      ].join(", ")
    )
    .filter({ hasNotText: /applied to/i })
    .last();
}

async function isWidgetOpen(page) {
  const widget = widgetLocator(page);
  return (await widget.count().catch(() => 0)) > 0 && (await widget.isVisible().catch(() => false));
}

async function labelForField(container, input) {
  const id = await input.getAttribute("id").catch(() => null);
  if (id) {
    const byFor = container.locator(`xpath=.//label[@for="${id}"]`);
    if (await byFor.count()) return (await byFor.first().innerText().catch(() => "")).trim();
  }
  const wrappingLabel = input.locator("xpath=ancestor::label[1]");
  if (await wrappingLabel.count()) {
    return (await wrappingLabel.first().innerText().catch(() => "")).trim();
  }
  // Fall back to the nearest preceding heading/question text block.
  const nearbyQuestion = container
    .locator("xpath=.//*[self::p or self::div or self::span or self::h3 or self::label]")
    .filter({ hasText: /\?|select|choose|enter/i });
  if (await nearbyQuestion.count()) {
    return (await nearbyQuestion.last().innerText().catch(() => "")).trim();
  }
  return "";
}

async function collectFields(widget) {
  const fields = [];

  const radioGroups = new Map();
  for (const radio of await widget.locator('input[type="radio"]').all()) {
    const name = (await radio.getAttribute("name").catch(() => null)) || "group";
    if (!radioGroups.has(name)) radioGroups.set(name, []);
    const label = await labelForField(widget, radio);
    radioGroups.get(name).push({ locator: radio, label });
  }
  for (const [name, options] of radioGroups) {
    if (!options.length) continue;
    fields.push({ type: "radio", question: options[0].label || name, options });
  }

  for (const select of await widget.locator("select").all()) {
    const label = await labelForField(widget, select);
    const options = (await select.locator("option").allInnerTexts()).map((o) => o.trim());
    fields.push({ type: "select", question: label, options, input: select });
  }

  for (const textInput of await widget
    .locator('input[type="text"], input[type="number"], input[type="tel"], textarea')
    .all()) {
    const label = await labelForField(widget, textInput);
    if (!label) continue;
    fields.push({ type: "text", question: label, input: textInput });
  }

  return fields;
}

async function answerField(page, field, jobContext) {
  let answer = matchKnownAnswer(field.question, field);
  let source = "qa-bank";

  if (answer === SKIP) {
    logAnswer(jobContext, field.question, "(left as-is)", "skip");
    return true;
  }

  if (answer == null) {
    const ai = await resolveWithAI(field.question, field, jobContext);
    if (!ai) {
      console.log(`    [CHATBOT][UNRESOLVED] "${field.question}" — logged for manual review`);
      return false;
    }
    answer = ai.answer;
    source = ai.source;
  }

  logAnswer(jobContext, field.question, answer, source);

  switch (field.type) {
    case "text": {
      await humanType(page, field.input, answer);
      break;
    }
    case "select": {
      const ok = await field.input
        .selectOption({ label: answer })
        .then(() => true)
        .catch(() => false);
      if (!ok) await field.input.selectOption(answer).catch(() => {});
      break;
    }
    case "radio": {
      const opt =
        field.options.find((o) => o.label.toLowerCase() === String(answer).toLowerCase()) ||
        field.options.find((o) => o.label.toLowerCase().includes(String(answer).toLowerCase()));
      if (opt) await humanClick(page, opt.locator);
      break;
    }
  }

  await humanDelay(
    CONFIG.limits.minDelayBetweenFormStepsMs,
    CONFIG.limits.maxDelayBetweenFormStepsMs
  );
  return true;
}

/**
 * If Naukri shows a screening-question widget after Apply, answers it and
 * submits. No-ops (returns immediately) if no widget appears within the
 * short poll window — the normal "instant apply" path.
 *
 * @returns {"none"|"completed"|"needs_review"}
 */
export async function handleScreeningQuestionsIfAny(page, jobContext) {
  const pollDeadline = Date.now() + 4000;
  let widget = null;
  while (Date.now() < pollDeadline) {
    if (await isWidgetOpen(page)) {
      widget = widgetLocator(page);
      break;
    }
    await sleep(300);
  }
  if (!widget) return "none";

  console.log("  [CHATBOT] Screening question widget detected — answering...");

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (!(await isWidgetOpen(page))) return "completed";

    const fields = await collectFields(widget);
    let anyUnresolved = false;
    for (const field of fields) {
      const ok = await answerField(page, field, jobContext);
      if (!ok) anyUnresolved = true;
    }

    if (anyUnresolved) {
      console.log("  [CHATBOT] Unresolved question(s) — leaving for manual review.");
      return "needs_review";
    }

    const advanceBtn = widget
      .getByRole("button", { name: /^(submit|send|save|next|apply|done)$/i })
      .first();
    if (await advanceBtn.count().catch(() => 0)) {
      await humanClick(page, advanceBtn);
      await humanDelay(800, 1600);
      continue;
    }

    // No obvious "next" control and nothing left to answer — assume done.
    return "completed";
  }

  console.log("  [CHATBOT] Exceeded max steps — leaving for manual review.");
  return "needs_review";
}

export default handleScreeningQuestionsIfAny;
