/** Handles the optional post-Apply screening drawer. */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { matchKnownAnswer, SKIP } from "./qaBank.js";
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
      if (text.length > 3000 || !/\?/.test(text)) continue;
      if (await visibleLast(panel.locator(`${INPUTS}, select, [role="radio"], input[type="radio"]`))) return panel;
    }
  }
  return null;
}

export async function applicationConfirmed(page) {
  return !!await visibleLast(page.getByText(/^(?:applied|successfully applied|you have successfully applied(?:.*)?|application (?:submitted|sent)(?: successfully)?[.!]?)$/i));
}

async function readQuestion(panel) {
  const text = (await panel.innerText()).replace(/[ \t]+/g, " ").trim();
  const questions = [...text.matchAll(/([^?\n]+\?)/g)];
  if (questions.length) return questions.at(-1)[1].trim();
  return text.split("\n").map(s => s.trim()).filter(s => s && !/^(save|skip this question|yes|no)$/i.test(s)).at(-1) || "";
}

async function fieldFor(panel) {
  // Hidden radios from earlier steps must not mask the current text field.
  const input = await visibleLast(panel.locator(INPUTS));
  if (input) return { type: await input.getAttribute("type") === "number" ? "number" : "text", locator: input };
  const select = await visibleLast(panel.locator("select"));
  if (select) return { type: "select", locator: select, options: await select.locator("option:not([disabled])").allTextContents() };
  const radios = panel.getByRole("radio");
  const options = [];
  for (let i = 0; i < await radios.count(); i++) {
    const radio = radios.nth(i);
    if (!await radio.isVisible()) continue;
    const label = await radio.evaluate(el => el.getAttribute("aria-label") ||
      (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim() ||
      [...(el.labels || [])].map(l => l.textContent).join(" ") || el.textContent || el.value);
    if (label?.trim()) options.push(label.trim());
  }
  if (options.length) return { type: "radio", options };
  if (await visibleLast(panel.getByText(/^yes$/i)) && await visibleLast(panel.getByText(/^no$/i))) return { type: "radio", options: ["Yes", "No"] };
  return null;
}

async function fillAnswer(panel, field, answer) {
  if (field.type === "text" || field.type === "number") {
    await field.locator.fill(answer, { timeout: 5000 });
    const actual = await field.locator.evaluate(el => "value" in el ? el.value : el.textContent);
    return actual?.trim() === answer.trim();
  }
  if (field.type === "select") {
    await field.locator.selectOption({ label: answer }, { timeout: 5000 });
    return (await field.locator.locator("option:checked").innerText()).trim() === answer;
  }
  const radio = await visibleLast(panel.getByRole("radio", { name: answer, exact: true }));
  if (radio) {
    if (await radio.isChecked()) return true;
    if (!await radio.isEnabled()) return false;

    // Styled radios can have a nonzero box (isVisible=true) while CSS puts
    // the actual input outside the viewport. Click the visible label first.
    const identity = await radio.evaluate(el => ({ id: el.id, name: el.name, value: el.value }));
    const labels = panel.locator("label");
    for (let i = 0; i < await labels.count(); i++) {
      const label = labels.nth(i);
      const associated = await label.evaluate((el, target) => {
        const control = el.control;
        return !!control && (target.id ? control.id === target.id :
          control.name === target.name && control.value === target.value);
      }, identity);
      if (!associated || !await label.isVisible()) continue;
      await label.click({ timeout: 1500 }).catch(() => {});
      if (await radio.isChecked()) return true;
    }

    // Some variants bind the click handler to an option row instead of a
    // label. Clicking its text bubbles to that row; verify the actual input.
    const option = await visibleLast(panel.getByText(answer, { exact: true }));
    if (option) {
      await option.click({ timeout: 1500 }).catch(() => {});
      if (await radio.isChecked()) return true;
    }

    // Keep native radios working, but never force-click an offscreen input
    // or claim that selecting its text necessarily selected the control.
    await radio.check({ timeout: 1500 }).catch(() => {});
    return await radio.isChecked();
  }
  const option = await visibleLast(panel.getByText(answer, { exact: true }));
  if (!option) return false;
  await option.click({ timeout: 5000 });
  return true;
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
        if (visible(root) && text.length <= 5000 && (/\?/.test(text) || /skip this question/i.test(text))) roots.add(root);
      }
      const controls = document.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="radio"], [role="option"], button');
      for (const control of controls) {
        let root = control.closest('[role="dialog"], aside, form, section');
        if (!root) {
          root = control.parentElement;
          while (root && root !== document.body) {
            const text = clean(root.innerText);
            if (text.length >= 10 && text.length <= 3000 && (/\?/.test(text) || /skip this question/i.test(text))) break;
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
        for (const element of root.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="radio"], [role="option"], button')) {
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
      const question = await readQuestion(panel);
      const field = await fieldFor(panel);
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
      if (answer == null || String(answer).trim() === "") {
        console.log(`${prefix}[CHATBOT] Q&A bank has no grounded answer; trying OpenAI...`);
        const resolved = await aiResolver(question, descriptor, jobContext);
        if (!resolved?.answer) {
          const reason = resolved?.error ? ` (${resolved.error})` : "";
          return await diagnostic(page, jobContext, `No answer available: ${question}${reason}`);
        }
        ({ answer, source } = resolved);
      }
      answer = String(answer).trim();
      if (field.options && !field.options.includes(answer)) return await diagnostic(page, jobContext, `Answer does not match available options: ${question}`);
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
