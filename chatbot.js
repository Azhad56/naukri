/** Handles the optional post-Apply screening drawer. */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { matchKnownAnswer, isNonAnswerOption, SKIP } from "./qaBank.js";
import { resolveWithAI } from "./aiFallback.js";
import { humanDelay, sleep } from "./humanize.js";
import { logAnswer } from "./logger.js";
import { cardPrefix } from "./pagination.js";

const INPUTS = 'input:not([type]), input[type="text"], input[type="number"], input[type="email"], input[type="tel"], textarea, [contenteditable="true"]';
const CHAT_ANCHORS = '[placeholder*="type message" i], [placeholder*="type your" i], [placeholder*="enter your" i]';

async function visibleLast(locator) {
  for (let i = await locator.count() - 1; i >= 0; i--) {
    if (await locator.nth(i).isVisible()) return locator.nth(i);
  }
  return null;
}

async function saveControl(panel) {
  // Naukri may render Save as a styled element instead of a native button.
  return await visibleLast(panel.getByRole("button", { name: /^save$/i })) ||
    await visibleLast(panel.getByText(/^save$/i));
}

export async function findQuestionPanel(page) {
  for (const frame of page.frames()) {
    const anchors = frame.locator(CHAT_ANCHORS).or(frame.getByText(/^skip this question$/i));
    for (let i = await anchors.count() - 1; i >= 0; i--) {
      const anchor = anchors.nth(i);
      if (!await anchor.isVisible()) continue;
      const ancestors = anchor.locator('xpath=ancestor::*[self::div or self::section or self::aside or self::form or @role="dialog"]');
      for (let j = await ancestors.count() - 1; j >= 0; j--) {
        const panel = ancestors.nth(j);
        if (await saveControl(panel)) return panel;
      }
    }
    // Require both a question and a field in a bounded container. This avoids
    // using the job page's bookmark Save and search box as screening controls.
    const panels = frame.locator('[role="dialog"], aside, section, form, div').filter({ has: frame.getByText(/^save$/i) });
    for (let i = await panels.count() - 1; i >= 0; i--) {
      const panel = panels.nth(i);
      if (!await panel.isVisible()) continue;
      const text = await panel.innerText();
      if (text.length > 5000 || !/\?|(?:^|\n)\s*(?:please\s+)?(?:select|choose|enter|provide)\b|willing to relocate/i.test(text)) continue;
      if (await visibleLast(panel.locator(`${INPUTS}, select, [role="radio"], input[type="radio"], [role="checkbox"], input[type="checkbox"]`))) return panel;
      // Custom checkboxes may hide the native input completely.
      if ((await choiceFields(panel, "checkbox")).length) return panel;
    }
  }
  return null;
}

export async function applicationConfirmed(page) {
  return !!await visibleLast(page.getByText(/^(?:applied|successfully applied|you have successfully applied(?:.*)?|application (?:submitted|sent)(?: successfully)?[.!]?)$/i));
}

async function readQuestion(panel, field) {
  // Read only content before the active control, so option labels and old
  // answered questions cannot replace a newer prompt without a question mark.
  const anchor = field.locator || field.choices?.[0]?.locator;
  const text = anchor ? await anchor.evaluate(el => {
    const root = el.closest('[data-screening-root]');
    if (!root) return "";
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEndBefore(el.closest('label') || el);
    const fragment = range.cloneContents();
    fragment.querySelectorAll('input, select, textarea, button, label, [role="radio"], [role="checkbox"], [contenteditable]').forEach(node => node.remove());
    // Preserve line boundaries even when the site uses adjacent divs.
    fragment.querySelectorAll('div, p, h1, h2, h3, h4, br').forEach(node => node.append('\n'));
    return fragment.textContent;
  }) : await panel.innerText();
  const lines = (text || "").split("\n").map(s => s.replace(/\s+/g, " ").trim())
    .filter(s => s && !/^(save|skip this question|yes|no|\d+(?:\.\d+)?)$/i.test(s));
  let prompt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\?|^(?:please\s+)?(?:select|choose|enter|provide|what|how|are|do|have|where|when|why)\b/i.test(lines[i])) prompt = i;
  }
  return (prompt >= 0 ? lines.slice(prompt) : lines.slice(-1)).join(" ");
}

async function choiceFields(panel, role) {
  const choices = [];
  const controls = panel.getByRole(role, { includeHidden: true });
  for (let i = 0; i < await controls.count(); i++) {
    const locator = controls.nth(i);
    const details = await locator.evaluate(el => {
      const labels = [...(el.labels || [])];
      const visible = node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return {
        visible: visible(el) || labels.some(visible),
        label: el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() ||
          labels.map(label => label.textContent).join(' ') || el.textContent || el.value,
      };
    });
    if (details.visible && details.label?.trim()) choices.push({ label: details.label.trim(), locator });
  }
  return choices;
}

async function fieldFor(panel) {
  const checkboxes = await choiceFields(panel, "checkbox");
  if (checkboxes.some(choice => !isNonAnswerOption(choice.label))) {
    return { type: "checkbox", choices: checkboxes, options: checkboxes.map(choice => choice.label) };
  }
  // Hidden radios from earlier steps must not mask the current text field.
  const input = await visibleLast(panel.locator(INPUTS));
  if (input) return { type: await input.getAttribute("type") === "number" ? "number" : "text", locator: input };
  const select = await visibleLast(panel.locator("select"));
  if (select) return { type: await select.evaluate(el => el.multiple) ? "multiselect" : "select", locator: select, options: await select.locator("option:not([disabled])").allTextContents() };
  const radios = await choiceFields(panel, "radio");
  if (radios.length) return { type: "radio", choices: radios, options: radios.map(choice => choice.label) };
  if (await visibleLast(panel.getByText(/^yes$/i)) && await visibleLast(panel.getByText(/^no$/i))) return { type: "radio", options: ["Yes", "No"] };
  return null;
}

async function fillAnswer(panel, field, answer) {
  if (field.type === "checkbox") {
    // Clear incompatible preselected choices (including Skip), then select and
    // verify every requested option. Repeated runs must never toggle them off.
    for (const choice of [...field.choices].sort((a, b) => Number(answer.includes(a.label)) - Number(answer.includes(b.label)))) {
      if (!await setChoice(panel, choice.locator, choice.label, answer.includes(choice.label))) return false;
    }
    for (const choice of field.choices) {
      if (await choice.locator.isChecked() !== answer.includes(choice.label)) return false;
    }
    return true;
  }
  if (field.type === "text" || field.type === "number") {
    await field.locator.fill(answer, { timeout: 5000 });
    const actual = await field.locator.evaluate(el => "value" in el ? el.value : el.textContent);
    return actual?.trim() === answer.trim();
  }
  if (field.type === "select" || field.type === "multiselect") {
    const values = Array.isArray(answer) ? answer : [answer];
    await field.locator.selectOption(values.map(label => ({ label })), { timeout: 5000 });
    const actual = await field.locator.locator("option:checked").allTextContents();
    return actual.length === values.length && actual.every(value => values.includes(value.trim()));
  }
  const radio = field.choices?.find(choice => choice.label === answer)?.locator;
  if (radio) return setChoice(panel, radio, answer, true);
  const option = await visibleLast(panel.getByText(answer, { exact: true }));
  if (!option) return false;
  await option.click({ timeout: 5000 });
  return true;
}

async function setChoice(panel, control, answer, checked) {
  if (await control.isChecked() === checked) return true;
  if (!await control.isEnabled()) return false;
  const labels = panel.locator('label');
  for (let i = 0; i < await labels.count(); i++) {
    const label = labels.nth(i);
    const handle = await control.elementHandle();
    const associated = await label.evaluate((el, target) => el.control === target, handle);
    await handle?.dispose();
    if (!associated || !await label.isVisible()) continue;
    await label.click({ timeout: 1500 }).catch(() => {});
    if (await control.isChecked() === checked) return true;
  }
  const option = await visibleLast(panel.getByText(answer, { exact: true }));
  if (option) {
    await option.click({ timeout: 1500 }).catch(() => {});
    if (await control.isChecked() === checked) return true;
  }
  await control.setChecked(checked, { timeout: 1500 }).catch(() => {});
  return await control.isChecked() === checked;
}

function normalizeAnswer(answer, field) {
  if (answer == null) return null;
  const multi = field.type === "checkbox" || field.type === "multiselect";
  const values = (Array.isArray(answer) ? answer : [answer]).map(value => String(value).trim()).filter(Boolean);
  if (!values.length || (!multi && values.length !== 1)) return null;
  if (field.options?.length && values.some(value => !field.options.includes(value) || isNonAnswerOption(value) && /skip|select |choose/i.test(value))) return null;
  if (field.type === "number" && !/^-?\d+(?:\.\d+)?$/.test(values[0])) return null;
  return multi ? [...new Set(values)] : values[0];
}

async function collectScreeningDetails(page) {
  const details = [];
  for (const frame of page.frames()) {
    const frameDetails = await frame.evaluate(() => {
      const clean = value => (value || "").replace(/\s+/g, " ").trim();
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const roots = new Set();
      for (const root of document.querySelectorAll('[role="dialog"], aside, form, section')) {
        const text = clean(root.innerText);
        if (visible(root) && text.length <= 5000 && (/\?/.test(text) || /skip this question|select.*(?:cit|location)|relocat/i.test(text))) roots.add(root);
      }
      const controls = document.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="option"], button');
      for (const control of controls) {
        let root = control.closest('[role="dialog"], aside, form, section');
        if (!root) {
          root = control.parentElement;
          while (root && root !== document.body) {
            const text = clean(root.innerText);
            if (text.length >= 10 && text.length <= 3000 && (/\?/.test(text) || /skip this question|select.*(?:cit|location)|relocat/i.test(text))) break;
            root = root.parentElement;
          }
        }
        if (root && root !== document.body && visible(root)) roots.add(root);
      }

      return [...roots].map(root => {
        const rawText = clean(root.innerText).slice(0, 3000);
        const questions = [...rawText.matchAll(/([^?]{3,500}\?)/g)].map(match => clean(match[1]));
        const question = questions.at(-1) || rawText.split(/\n/).map(clean).find(line =>
          line.length > 4 && !/^(yes|no|save|submit|continue|next|skip this question)$/i.test(line)
        ) || "(question text not identified)";
        const options = [];
        const controlTypes = new Set();
        for (const element of root.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="option"], button')) {
          const tag = element.tagName.toLowerCase();
          const type = clean(element.getAttribute("type") || element.getAttribute("role") ||
            (element.isContentEditable ? "contenteditable" : tag));
          controlTypes.add(type);
          if (tag === "select") {
            for (const option of element.options) {
              const value = clean(option.textContent);
              if (value && !option.disabled && !/select (?:an )?option/i.test(value)) options.push(value);
            }
            continue;
          }
          if (type === "radio" || type === "checkbox" || type === "option") {
            const value = clean(element.getAttribute("aria-label") ||
              [...(element.labels || [])].map(label => label.textContent).join(" ") ||
              element.textContent || element.getAttribute("value"));
            if (value) options.push(value);
            continue;
          }
          if (tag === "button") {
            const value = clean(element.innerText || element.getAttribute("aria-label"));
            if (value && !/^(save|submit|continue|next|back|close|apply|skip this question)$/i.test(value)) options.push(value);
          }
        }
        return {
          question,
          options: [...new Set(options)],
          controlTypes: [...controlTypes],
          panelText: rawText,
        };
      });
    }).catch(() => []);
    details.push(...frameDetails);
  }
  return details.filter((detail, index, all) =>
    index === all.findIndex(other => other.question === detail.question &&
      JSON.stringify(other.options) === JSON.stringify(detail.options))
  );
}

async function diagnostic(page, jobContext, reason) {
  const prefix = cardPrefix(jobContext);
  console.log(`${prefix}[CHATBOT] Needs review: ${reason}`);
  const screeningDetails = await collectScreeningDetails(page);
  if (screeningDetails.length) {
    for (const [index, detail] of screeningDetails.entries()) {
      console.log(`${prefix}[CHATBOT] Unresolved question ${index + 1}: "${detail.question}"`);
      console.log(`${prefix}[CHATBOT] Available options ${index + 1}: ${detail.options.length ? JSON.stringify(detail.options) : "(none detected)"}`);
      console.log(`${prefix}[CHATBOT] Detected controls ${index + 1}: ${detail.controlTypes.length ? detail.controlTypes.join(", ") : "(none detected)"}`);
    }
  } else {
    console.log(`${prefix}[CHATBOT] No question/options could be extracted from the current page.`);
  }
  const dir = path.join(CONFIG.profileDir, "..", "debug");
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${Date.now()}-chatbot-unresolved.png`), fullPage: true }).catch(() => {});
  let entries = [];
  if (fs.existsSync(CONFIG.files.reviewQueue)) entries = JSON.parse(fs.readFileSync(CONFIG.files.reviewQueue, "utf8"));
  entries.push({
    job: jobContext,
    reason,
    pageUrl: page.url(),
    screeningDetails,
    at: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(CONFIG.files.reviewQueue), { recursive: true });
  fs.writeFileSync(CONFIG.files.reviewQueue, JSON.stringify(entries, null, 2));
  return "needs_review";
}

/** "none" means direct application confirmed; closing a drawer is not success. */
export async function handleScreeningQuestionsIfAny(page, jobContext, options = {}) {
  const prefix = cardPrefix(jobContext);
  const timeoutMs = options.timeoutMs ?? 15000;
  const pollMs = options.pollMs ?? 250;
  const betweenQuestionMinMs = options.betweenQuestionMinMs ?? 1000;
  const betweenQuestionMaxMs = options.betweenQuestionMaxMs ?? 3000;
  const aiResolver = options.aiResolver ?? resolveWithAI;
  let deadline = Date.now() + timeoutMs;
  let pending = null;
  let answered = 0;
  try {
    while (Date.now() < deadline) {
      const panel = await findQuestionPanel(page);
      if (!panel) {
        if (await applicationConfirmed(page)) {
          if (pending) logAnswer(jobContext, pending.question, pending.answer, pending.source, "saved");
          return answered ? "completed" : "none";
        }
        await sleep(pollMs);
        continue;
      }
      const field = await fieldFor(panel);
      if (!field) { await sleep(pollMs); continue; }
      await panel.evaluate(el => el.setAttribute('data-screening-root', ''));
      const question = await readQuestion(panel, field);
      if (!question || !field) { await sleep(pollMs); continue; }
      if (pending) {
        if (question === pending.question) { await sleep(pollMs); continue; }
        logAnswer(jobContext, pending.question, pending.answer, pending.source, "saved");
        pending = null;
        const breathSeconds = `${(betweenQuestionMinMs / 1000).toFixed(1)}-${(betweenQuestionMaxMs / 1000).toFixed(1)}`;
        console.log(`${prefix}[CHATBOT] Taking a little breath before the next question (${breathSeconds}s)...`);
        await humanDelay(betweenQuestionMinMs, betweenQuestionMaxMs);
        // The drawer may rerender while waiting, so restart detection instead
        // of answering through locators captured before the pause.
        deadline = Date.now() + timeoutMs;
        continue;
      }
      if (answered >= 30) return await diagnostic(page, jobContext, "Screening exceeded 30 questions");
      console.log(`${prefix}[CHATBOT] Question: "${question}" (${field.type})`);
      const descriptor = { type: field.type, options: field.options };
      let answer = matchKnownAnswer(question, descriptor);
      let source = "qa-bank";
      if (answer === SKIP) {
        answer = field.locator ? await field.locator.evaluate(el => "value" in el ? el.value : el.textContent) : null;
        source = "prefilled";
      }
      answer = normalizeAnswer(answer, field);
      if (answer == null) {
        console.log(`${prefix}[CHATBOT] Q&A bank has no grounded answer; trying OpenAI...`);
        const resolved = await aiResolver(question, descriptor, jobContext);
        if (!resolved?.answer) {
          const reason = resolved?.error ? ` (${resolved.error})` : "";
          return await diagnostic(page, jobContext, `No answer available: ${question}${reason}`);
        }
        ({ answer, source } = resolved);
      }
      answer = normalizeAnswer(answer, field);
      if (answer == null) return await diagnostic(page, jobContext, `Answer does not match field or available options: ${question}`);
      if (!await fillAnswer(panel, field, answer)) return await diagnostic(page, jobContext, `Answer did not register: ${question}`);
      logAnswer(jobContext, question, answer, source, "filled");
      const save = await saveControl(panel);
      if (!save) return await diagnostic(page, jobContext, `Save control missing: ${question}`);
      const saveDeadline = Date.now() + Math.min(timeoutMs, 5000);
      let enabled = false;
      while (Date.now() < saveDeadline) {
        enabled = await save.isEnabled() && await save.getAttribute("aria-disabled") !== "true" &&
          !/(^|\s)disabled(\s|$)/i.test(await save.getAttribute("class") || "");
        if (enabled) break;
        await sleep(pollMs);
      }
      if (!enabled) return await diagnostic(page, jobContext, `Save stayed disabled: ${question}`);
      pending = { question, answer, source };
      await save.click({ timeout: 5000 });
      answered++;
      deadline = Date.now() + timeoutMs;
      await sleep(pollMs);
    }
    return await diagnostic(page, jobContext, pending ? `Saved answer did not advance: ${pending.question}` : "No application confirmation or supported question appeared");
  } catch (error) {
    return await diagnostic(page, jobContext, `Screening error: ${error.message}`);
  }
}

export default handleScreeningQuestionsIfAny;
