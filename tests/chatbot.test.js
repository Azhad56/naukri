import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { CONFIG } from '../config.js';
import { handleScreeningQuestionsIfAny } from '../chatbot.js';
import { matchKnownAnswer } from '../qaBank.js';

let browser, page, temp;
const job = { title: 'Fixture job', jobUrl: 'https://example.test/job' };
const run = (options = {}) => handleScreeningQuestionsIfAny(page, job, {
  timeoutMs: 1800,
  pollMs: 30,
  betweenQuestionMinMs: 0,
  betweenQuestionMaxMs: 0,
  ...options,
});
const question = 'How many years of experience do you have in Node.js?';
const drawer = (input = '<input placeholder="Type message here...">', save = '<button id="save" disabled>Save</button>') => `<aside><div id="question">${question}</div>${input}<div>Skip this question</div><footer>${save}</footer></aside>`;
const successScript = `<script>document.querySelector('aside').addEventListener('input', () => { const s = document.querySelector('#save'); s.disabled = false; s.setAttribute('aria-disabled', 'false'); }); document.querySelector('#save').onclick = () => { document.querySelector('aside').remove(); document.body.insertAdjacentHTML('beforeend','<button>Applied</button>'); };</script>`;
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-screening-'));
  CONFIG.profileDir = path.join(temp, 'profile');
  for (const key of Object.keys(CONFIG.files)) CONFIG.files[key] = path.join(temp, `${key}.json`);
  CONFIG.ai.enabled = false;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
  if (temp && path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('naukri-screening-')) {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('fills missing-type input, ignores page Save/search and hidden radios, persists saved Q&A', async () => {
  await page.setContent('<input type="text" id="search" value="untouched"><button>Save</button>' + drawer('<input type="radio" hidden><input placeholder="Type message here...">') + successScript);
  assert.equal(await run(), 'completed');
  assert.equal(await page.locator('#search').inputValue(), 'untouched');
  const logs = JSON.parse(fs.readFileSync(CONFIG.files.qaLog));
  assert.equal(logs.at(-1).question, question);
  assert.equal(logs.at(-1).answer, String(CONFIG.candidate.skills['node.js']));
  assert.equal(logs.at(-1).status, 'saved');
  assert.equal(logs.at(-1).jobUrl, job.jobUrl);
});

test('known Q&A-bank answer bypasses the OpenAI resolver', async () => {
  let calls = 0;
  await page.setContent(drawer() + successScript);
  const result = await run({
    aiResolver: async () => {
      calls++;
      return { answer: '99', source: 'openai' };
    },
  });
  assert.equal(result, 'completed');
  assert.equal(calls, 0);
});

test('unknown screening question uses the OpenAI resolver result', async () => {
  let request;
  await page.setContent(drawer().replace(question, 'What is your preferred development methodology?') + successScript);
  const result = await run({
    aiResolver: async (questionText, field, jobContext) => {
      request = { questionText, field, jobContext };
      return { answer: 'Agile', confidence: 'high', source: 'openai' };
    },
  });
  assert.equal(result, 'completed');
  assert.match(request.questionText, /development methodology/);
  assert.equal(request.field.type, 'text');
  assert.equal(request.jobContext.jobUrl, job.jobUrl);
  const logs = JSON.parse(fs.readFileSync(CONFIG.files.qaLog));
  assert.equal(logs.at(-1).answer, 'Agile');
  assert.equal(logs.at(-1).source, 'openai');
});

test('numeric input and custom Save element inside iframe', async () => {
  await page.setContent('<iframe></iframe>');
  await page.frames()[1].setContent(drawer('<input type="number" placeholder="Type message here...">', '<div id="save" aria-disabled="true">Save</div>') + successScript.replace("document.body.insertAdjacentHTML", "parent.document.body.insertAdjacentHTML"));
  assert.equal(await run(), 'completed');
});

test('contenteditable field', async () => {
  await page.setContent(drawer('<div contenteditable="true" style="min-height:30px"></div>') + successScript);
  assert.equal(await run(), 'completed');
});

test('waits for delayed popup and between questions', async () => {
  await page.setContent('<button>Apply</button>');
  await page.evaluate(({html}) => {
    setTimeout(() => {
      document.body.innerHTML = html;
      let step = 0;
      document.querySelector('input').oninput = () => document.querySelector('#save').disabled = false;
      document.querySelector('#save').onclick = () => {
        if (step++) { document.body.innerHTML = '<p>Application submitted successfully</p>'; return; }
        document.querySelector('aside').style.display = 'none';
        setTimeout(() => {
          document.querySelector('#question').textContent = 'What is your notice period?';
          document.querySelector('input').value = '';
          document.querySelector('#save').disabled = true;
          document.querySelector('aside').style.display = '';
        }, 200);
      };
    }, 150);
  }, { html: drawer() });
  assert.equal(await run(), 'completed');
});

test('takes the configured breath after saving before answering the next question', async () => {
  await page.setContent(drawer() + `<script>
    window.firstSavedAt = 0;
    window.secondAnsweredAt = 0;
    let step = 0;
    const input = document.querySelector('input');
    input.oninput = () => {
      document.querySelector('#save').disabled = false;
      if (step === 1) window.secondAnsweredAt = performance.now();
    };
    document.querySelector('#save').onclick = () => {
      if (step++ === 0) {
        window.firstSavedAt = performance.now();
        document.querySelector('#question').textContent = 'What is your notice period?';
        input.value = '';
        document.querySelector('#save').disabled = true;
      } else {
        document.body.innerHTML = '<p>Application submitted successfully</p>';
      }
    };
  </script>`);
  assert.equal(await run({ betweenQuestionMinMs: 120, betweenQuestionMaxMs: 120 }), 'completed');
  const elapsed = await page.evaluate(() => window.secondAnsweredAt - window.firstSavedAt);
  assert.ok(elapsed >= 110, `expected at least a 120ms breath, observed ${elapsed}ms`);
});

test('uses configured No for radio question instead of forcing Yes', async () => {
  await page.setContent('<aside><p>Do you require sponsorship?</p><label><input type="radio" name="a" value="Yes">Yes</label><label><input type="radio" name="a" value="No">No</label><div>Skip this question</div><button id="save" disabled>Save</button></aside>' + successScript);
  assert.equal(await run(), 'completed');
  const logs = JSON.parse(fs.readFileSync(CONFIG.files.qaLog));
  assert.equal(logs.at(-1).answer, CONFIG.candidate.requiresSponsorship ? 'Yes' : 'No');
});

test('select question', async () => {
  await page.setContent(drawer(`<select><option disabled selected>Select an option</option><option>${CONFIG.candidate.skills['node.js']}</option></select>`) + successScript);
  assert.equal(await run(), 'completed');
});

test('offscreen Naukri radio is selected through its visible associated label', async () => {
  await page.setContent(`<style>.ssrc__radio { position: fixed; left: -10000px; }</style>
    <aside><p>Are you living or willing to relocation to Gurgaon/Gurugram ?</p>
    <input id="Yes" value="Yes" type="radio" name="radio-button" class="ssrc__radio">
    <label for="Yes">Yes</label>
    <input id="No" value="No" type="radio" name="radio-button" class="ssrc__radio">
    <label for="No">No</label><div>Skip this question</div>
    <button id="save" disabled>Save</button></aside>` + successScript);
  await assert.rejects(page.locator('#Yes').check({ timeout: 150 }), /outside of the viewport|Timeout/);
  assert.equal(await run(), 'completed');
  const logs = JSON.parse(fs.readFileSync(CONFIG.files.qaLog));
  assert.equal(logs.at(-1).answer, 'Yes');
  assert.equal(logs.at(-1).status, 'saved');
});

test('offscreen radio with a clickable option row is verified before saving', async () => {
  await page.setContent(`<aside><p>Are you willing to relocate?</p>
    <div onclick="document.querySelector('#Yes').click()"><input style="position:fixed;left:-10000px" id="Yes" aria-label="Yes" name="a" type="radio" value="Yes"><span>Yes</span></div>
    <label><input name="a" type="radio" value="No">No</label>
    <div>Skip this question</div><button id="save" disabled>Save</button></aside>` + successScript);
  assert.equal(await run(), 'completed');
});

test('clicking inert option text does not log an unchecked radio as filled', async () => {
  await page.setContent(`<aside><p>Are you willing to relocate?</p>
    <input style="position:fixed;left:-10000px" aria-label="Yes" type="radio"><span>Yes</span>
    <label><input type="radio">No</label><div>Skip this question</div><button>Save</button></aside>`);
  const before = JSON.parse(fs.readFileSync(CONFIG.files.qaLog)).length;
  assert.equal(await run(), 'needs_review');
  assert.equal(JSON.parse(fs.readFileSync(CONFIG.files.qaLog)).length, before);
});

test('disabled Save remains unresolved', async () => {
  await page.setContent(drawer());
  assert.equal(await run(), 'needs_review');
});

test('unchanged question after Save is not submitted repeatedly', async () => {
  await page.setContent(drawer() + '<script>window.clicks=0; document.querySelector("input").oninput=()=>document.querySelector("#save").disabled=false; document.querySelector("#save").onclick=()=>window.clicks++;</script>');
  assert.equal(await run(), 'needs_review');
  assert.equal(await page.evaluate(() => window.clicks), 1);
});

test('direct apply needs visible confirmation', async () => {
  await page.setContent('<button>Applied</button>');
  assert.equal(await run(), 'none');
  await page.setContent('<button>Apply</button><button>Save</button><input type="text">');
  assert.equal(await run(), 'needs_review');
});

test('unsupported popup logs its question, options and control types for review', async () => {
  await page.setContent(`<div role="dialog">
    <p>How many years of experience do you have with Generative AI?</p>
    <button>0-2 years</button><button>3-5 years</button><button>More than 5 years</button>
    <button>Submit</button>
  </div>`);
  assert.equal(await run(), 'needs_review');
  const reviews = JSON.parse(fs.readFileSync(CONFIG.files.reviewQueue));
  const detail = reviews.at(-1).screeningDetails.at(-1);
  assert.equal(detail.question, 'How many years of experience do you have with Generative AI?');
  assert.deepEqual(detail.options, ['0-2 years', '3-5 years', 'More than 5 years']);
  assert.ok(detail.controlTypes.includes('button'));
  assert.equal(reviews.at(-1).pageUrl, 'about:blank');
});

test('unlisted skill uses configured total years of experience', () => {
  assert.equal(
    matchKnownAnswer('How many years of experience do you have in C++?', { type: 'text' }),
    String(CONFIG.candidate.totalYearsExperience)
  );
});

test('unlisted skill answer is filled and saved without OpenAI', async () => {
  await page.setContent(drawer().replace('Node.js', 'C++') + successScript);
  let calls = 0;
  assert.equal(await run({ aiResolver: async () => { calls++; return null; } }), 'completed');
  assert.equal(calls, 0);
  const logs = JSON.parse(fs.readFileSync(CONFIG.files.qaLog));
  assert.equal(logs.at(-1).answer, String(CONFIG.candidate.totalYearsExperience));
  assert.equal(logs.at(-1).source, 'qa-bank');
});
