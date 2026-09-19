/**
 * Naukri.com job-search + apply automation.
 *
 * Logs in via a persisted real Chrome session (see login.js), searches each
 * configured keyword, applies a Freshness filter + sorts by Date, then
 * visits each job's detail page directly. Jobs whose CTA is
 * "Apply on company site" are always skipped (external redirect, per your
 * requirement) — only jobs with a direct "Apply" button are applied to.
 * Any optional screening-question widget is answered via the resume-based
 * Q&A bank, with a local Ollama model as fallback for anything new.
 *
 * Prerequisite: run `npm run login` once to save your session.
 * Run: npm start
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { launchBrowser, getOrCreatePage } from "./browser.js";
import { humanClick, humanType, humanDelay, sleep } from "./humanize.js";
import { handleScreeningQuestionsIfAny } from "./chatbot.js";
import { logResult, alreadyHandled } from "./logger.js";

async function safeGoto(page, url, opts = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", ...opts });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  navigation retry ${attempt}/3 after error: ${err.message}`);
      await sleep(2000 * attempt);
    }
  }
}

/** Naukri's pages often have multiple DOM matches for the same placeholder
 * (hidden duplicates for responsive breakpoints, animated expand/collapse
 * states, etc). `.first()` picks whichever comes first in the DOM, which
 * is not necessarily the one actually visible on screen — pick the first
 * one that's really visible instead. */
async function firstVisible(page, selector) {
  const all = await page.locator(selector).all();
  for (const el of all) {
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** Types into a field the human way, then verifies the value actually
 * stuck (Naukri's animated/expanding widgets can eat keystrokes if focus
 * shifts mid-type) — falls back to a direct `.fill()` if not. */
async function typeAndVerify(page, locator, text) {
  await humanType(page, locator, text);
  await humanDelay(200, 400);
  const value = await locator.inputValue().catch(() => "");
  const firstWord = text.split(/[,\s]+/)[0];
  if (!value || !value.toLowerCase().includes(firstWord.toLowerCase())) {
    console.warn(`  [WARN] Field didn't retain typed text (got "${value}") — retrying with direct fill.`);
    await locator.click({ force: true }).catch(() => {});
    await locator.fill(text).catch(() => {});
    await humanDelay(200, 400);
  }
}

export async function detectSecurityCheckpoint(page) {
  const url = page.url();
  if (/captcha|blocked/i.test(url)) return true;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /unusual activity|verify you.?re a human|security check|access denied/i.test(bodyText);
}

const KEYWORD_SELECTOR = [
  'input[placeholder="Enter keyword / designation / companies"]',
  'input[placeholder*="Enter keyword" i]',
  'input[placeholder*="skills / designations" i]',
].join(", ");
const LOCATION_SELECTOR = 'input[placeholder="Enter location"], input[placeholder*="location" i]';
// The collapsed nav search box is NOT an <input>. The actual topmost
// clickable element (confirmed via live DevTools inspection + Playwright's
// own "intercepts pointer events" trace) is:
//   <button class="nI-gNb-sb__expand" aria-label="Search jobs here">
// which sits ON TOP OF the decorative <span class="nI-gNb-sb__placeholder">
// — clicking the span times out because this button always intercepts the
// click. Target the button directly.
const COLLAPSED_SEARCH_SELECTOR =
  'button.nI-gNb-sb__expand, button[aria-label="Search jobs here"], #nI-gNb-searchbar, span.nI-gNb-sb__placeholder';

/** Fills the homepage search box, picks experience, and submits. */
async function runSearch(page, keyword) {
  await safeGoto(page, "https://www.naukri.com/mnjuser/homepage");
  await humanDelay(1500, 2800);

  // On the logged-in homepage, the full keyword/experience/location search
  // bar starts collapsed into a small "Search jobs here" box in the top
  // nav. Clicking it expands the real search fields inline on the page —
  // only then are they visible/fillable. There can be multiple DOM matches
  // for the same placeholder (hidden duplicates for other breakpoints), so
  // always pick the one that's actually visible, not just DOM-first.
  let keywordInput = await firstVisible(page, KEYWORD_SELECTOR);

  if (!keywordInput) {
    const collapsedSearch = await firstVisible(page, COLLAPSED_SEARCH_SELECTOR);
    if (collapsedSearch) {
      // A decorative element sits on top of this button during its own
      // expand animation, which makes Playwright's normal actionability
      // checks retry-and-timeout. force:true skips those checks and just
      // dispatches the click — safe here since we know exactly what we're
      // targeting (confirmed via DevTools).
      await collapsedSearch.scrollIntoViewIfNeeded().catch(() => {});
      await collapsedSearch.click({ force: true, timeout: 5000 }).catch(async () => {
        await collapsedSearch.click().catch(() => {});
      });
    }
    // Poll for the now-expanded, visible keyword input rather than a fixed
    // delay — the expand animation/render can take a variable amount of time.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !keywordInput) {
      keywordInput = await firstVisible(page, KEYWORD_SELECTOR);
      if (!keywordInput) await sleep(300);
    }
  }

  if (!keywordInput) {
    await debugScreenshot(page, "keyword-input-not-found");
    throw new Error("Could not find/expand the keyword search field on the homepage.");
  }

  await typeAndVerify(page, keywordInput, keyword);
  await humanDelay(600, 1100);
  await page.keyboard.press("Escape").catch(() => {}); // close autocomplete dropdown

  if (CONFIG.search.experienceYears) {
    try {
      const expControl = page.getByText("Select experience", { exact: false }).first();
      if (await expControl.count().catch(() => 0)) {
        await humanClick(page, expControl).catch(() => expControl.click({ force: true }).catch(() => {}));
        await humanDelay(400, 800);
        const label = /^\d+$/.test(CONFIG.search.experienceYears)
          ? `${CONFIG.search.experienceYears} year${CONFIG.search.experienceYears === "1" ? "" : "s"}`
          : CONFIG.search.experienceYears;
        const option = page.getByText(label, { exact: true }).first();
        if (await option.count().catch(() => 0)) {
          await humanClick(page, option).catch(() => option.click({ force: true }).catch(() => {}));
        } else {
          console.warn(`  [WARN] Experience option "${label}" not found — leaving default.`);
        }
      }
    } catch (err) {
      console.warn(`  [WARN] Could not set experience filter: ${err.message}`);
    }
  }

  if (CONFIG.search.location) {
    try {
      const locInput = await firstVisible(page, LOCATION_SELECTOR);
      if (locInput) {
        await typeAndVerify(page, locInput, CONFIG.search.location);
        await humanDelay(400, 800);
        await page.keyboard.press("Escape").catch(() => {});
      }
    } catch (err) {
      console.warn(`  [WARN] Could not set location filter: ${err.message}`);
    }
  }

  // Sanity check right before hitting Search — log what we're actually
  // about to submit so a bad run is diagnosable from the console alone.
  const typedKeyword = await keywordInput.inputValue().catch(() => "");
  console.log(`  [SEARCH] Keyword field contains: "${typedKeyword}"`);
  if (!typedKeyword.trim()) {
    await debugScreenshot(page, "keyword-empty-before-search");
    throw new Error("Keyword field is empty right before clicking Search — aborting this keyword.");
  }

  // Submit via Enter on the keyword field rather than hunting for the right
  // "Search" button among several on the page (simpler and more reliable —
  // this is how a real form submit works, and matches normal browser
  // behavior for a search box like this).
  const urlBeforeSearch = page.url();
  await keywordInput.click({ force: true }).catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});

  let navigated = await page
    .waitForFunction((prev) => location.href !== prev, urlBeforeSearch, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (!navigated) {
    console.warn("  [WARN] Enter didn't navigate — retrying by clicking the Search button.");
    const searchBtn =
      (await firstVisible(page, 'button:has-text("Search")')) ||
      page.getByRole("button", { name: /^search$/i }).first();
    await searchBtn.click({ force: true, timeout: 5000 }).catch(() => {});
    navigated = await page
      .waitForFunction((prev) => location.href !== prev, urlBeforeSearch, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await humanDelay(2000, 3500);
  console.log(`  [SEARCH] Landed on: ${page.url()}`);

  if (/mnjuser\/homepage/.test(page.url())) {
    await debugScreenshot(page, "still-on-homepage-after-search");
    throw new Error("Still on the homepage after clicking Search — see debug screenshot.");
  }
}

/** Applies the Freshness filter and sorts by the configured order. Best-effort. */
async function applyFiltersAndSort(page) {
  if (CONFIG.search.freshness) {
    try {
      const freshnessControl = page.getByText("Freshness", { exact: false }).first();
      if (await freshnessControl.count().catch(() => 0)) {
        await humanClick(page, freshnessControl);
        await humanDelay(400, 800);
        const option = page.getByText(CONFIG.search.freshness, { exact: true }).first();
        if (await option.count().catch(() => 0)) {
          await humanClick(page, option);
          await humanDelay(1200, 2200);
        } else {
          console.warn(`  [WARN] Freshness option "${CONFIG.search.freshness}" not found.`);
        }
      }
    } catch (err) {
      console.warn(`  [WARN] Could not apply freshness filter: ${err.message}`);
    }
  }

  if (CONFIG.search.sortBy) {
    try {
      const sortControl = page.getByText(/sort by/i).first();
      if (await sortControl.count().catch(() => 0)) {
        await humanClick(page, sortControl);
        await humanDelay(400, 800);
        const option = page.getByText(CONFIG.search.sortBy, { exact: false }).last();
        if (await option.count().catch(() => 0)) {
          await humanClick(page, option);
          await humanDelay(1200, 2200);
        } else {
          console.warn(`  [WARN] Sort option "${CONFIG.search.sortBy}" not found.`);
        }
      }
    } catch (err) {
      console.warn(`  [WARN] Could not apply sort order: ${err.message}`);
    }
  }
}

/** Reads {href, title} for every job card visible on the current results page.
 * Matches by href pattern first (job detail URLs all look like
 * naukri.com/job-listings-...) since that's far more stable across Naukri's
 * frequent class-name/redesign churn than a CSS class like `a.title`. */
async function collectCards(page) {
  await page
    .locator('a[href*="/job-listings-"], a.title')
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});

  const anchors = await page.locator('a[href*="/job-listings-"], a.title').all();
  const seen = new Set();
  const cards = [];
  for (const a of anchors) {
    const href = await a.getAttribute("href").catch(() => null);
    if (!href || seen.has(href)) continue;
    const title = (await a.innerText().catch(() => "")).split("\n")[0].trim();
    if (!title) continue; // filters out non-title anchors that also match the href pattern
    seen.add(href);
    cards.push({ href, title });
  }
  return cards;
}

async function debugScreenshot(page, tag) {
  try {
    const dir = path.join(CONFIG.profileDir, "..", "debug");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${tag}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  [DEBUG] Saved screenshot: ${file}`);
  } catch {
    // best-effort only
  }
}

/** Clicks "Next" in the results pagination bar. Returns the new URL, or null if there's no next page. */
async function goToNextResultsPage(page) {
  const nextBtn = page
    .locator('a, button, span')
    .filter({ hasText: /^next$/i })
    .last();
  if (!(await nextBtn.count().catch(() => 0))) return null;

  await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
  const disabled = await nextBtn
    .evaluate((el) => el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true")
    .catch(() => false);
  if (disabled) return null;

  await humanClick(page, nextBtn);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await humanDelay(1800, 3200);
  return page.url();
}

/** Visits a single job detail page and applies, skips, or handles screening questions. */
async function processJob(page, card, jobContext) {
  await safeGoto(page, card.href);
  await humanDelay(1200, 2200);

  if (await detectSecurityCheckpoint(page)) throw new Error("SECURITY_CHECKPOINT_DETECTED");

  const companySiteBtn = page.getByRole("button", { name: /apply on company site/i }).first();
  if (await companySiteBtn.count().catch(() => 0)) {
    console.log(`[SKIP] ${jobContext.title} — requires "Apply on company site"`);
    logResult({ ...jobContext, status: "skipped", reason: "apply_on_company_site" });
    return;
  }

  const alreadyAppliedBtn = page.getByText(/^applied$/i).first();
  if (await alreadyAppliedBtn.count().catch(() => 0)) {
    console.log(`[SKIP] ${jobContext.title} — already applied previously`);
    logResult({ ...jobContext, status: "skipped", reason: "already_applied" });
    return;
  }

  const applyBtn = page.getByRole("button", { name: /^apply$/i }).first();
  if (!(await applyBtn.count().catch(() => 0))) {
    console.log(`[SKIP] ${jobContext.title} — no direct Apply button found`);
    logResult({ ...jobContext, status: "skipped", reason: "no_apply_button" });
    return;
  }

  console.log(`[OPEN] ${jobContext.title}`);
  await humanClick(page, applyBtn);
  await humanDelay(1000, 2000);

  const screeningResult = await handleScreeningQuestionsIfAny(page, jobContext);

  logResult({ ...jobContext, status: "applied", screening: screeningResult });
  console.log(`[APPLIED] ${jobContext.title}${screeningResult === "completed" ? " (answered screening questions)" : ""}`);
}

async function processKeyword(page, keyword, state) {
  console.log(`\n=== Keyword: "${keyword}" ===`);
  try {
    await runSearch(page, keyword);
  } catch (err) {
    if (err.message === "SECURITY_CHECKPOINT_DETECTED") throw err;
    console.error(`  [SKIP KEYWORD] Search failed for "${keyword}": ${err.message}`);
    return;
  }
  await applyFiltersAndSort(page);

  let handledForKeyword = 0;
  let pageNum = 1;

  while (
    handledForKeyword < CONFIG.limits.maxApplicationsPerKeyword &&
    state.totalApplied < CONFIG.limits.maxApplicationsPerRun &&
    pageNum <= CONFIG.limits.maxPagesPerKeyword
  ) {
    if (await detectSecurityCheckpoint(page)) throw new Error("SECURITY_CHECKPOINT_DETECTED");

    const cards = await collectCards(page);
    if (!cards.length) {
      console.log(`No job cards found — stopping this keyword. (current URL: ${page.url()})`);
      await debugScreenshot(page, `no-cards-${keyword.replace(/\W+/g, "-")}`);
      break;
    }

    // Capture the results URL now, while we're confidently on the results
    // page, so we can return to it after visiting each job's detail page.
    const resultsUrl = page.url();

    for (const card of cards) {
      if (handledForKeyword >= CONFIG.limits.maxApplicationsPerKeyword) break;
      if (state.totalApplied >= CONFIG.limits.maxApplicationsPerRun) break;
      if (state.seenUrls.has(card.href) || alreadyHandled(card.href)) continue;
      state.seenUrls.add(card.href);

      const jobContext = { jobUrl: card.href, title: card.title || "Untitled", keyword };

      try {
        await processJob(page, card, jobContext);
      } catch (err) {
        if (err.message === "SECURITY_CHECKPOINT_DETECTED") throw err;
        console.error(`[FAILED] ${jobContext.title}: ${err.message}`);
        logResult({ ...jobContext, status: "failed", error: err.message });
        continue;
      }

      // Counts every processed job (applied or skipped) toward the per-keyword
      // cap so a run doesn't spend all its time re-checking "company site"
      // jobs; only real applications increment the overall run counter's
      // pacing logic below, but we still count skips here to keep moving on.
      handledForKeyword += 1;
      state.totalApplied += 1;

      if (state.totalApplied > 0 && state.totalApplied % CONFIG.limits.longBreakEvery === 0) {
        const breakMs =
          CONFIG.limits.longBreakMinMs +
          Math.floor(Math.random() * (CONFIG.limits.longBreakMaxMs - CONFIG.limits.longBreakMinMs));
        console.log(`\n[BREAK] Taking a longer human-like break: ${Math.round(breakMs / 1000)}s...\n`);
        await sleep(breakMs);
      } else {
        await humanDelay(CONFIG.limits.minDelayBetweenJobsMs, CONFIG.limits.maxDelayBetweenJobsMs);
      }
    }

    console.log(`  -> processed page ${pageNum} (${cards.length} cards)`);

    // processJob() above navigated the page away to job detail URLs —
    // return to the results listing before looking for pagination controls.
    await safeGoto(page, resultsUrl);
    await humanDelay(1000, 1800);

    const nextUrl = await goToNextResultsPage(page);
    if (!nextUrl) {
      console.log("No further result pages.");
      break;
    }
    pageNum += 1;
  }

  console.log(`Keyword "${keyword}" done.`);
}

async function main() {
  console.log("Starting Naukri automation...");
  console.log(
    `Limits: ${CONFIG.limits.maxApplicationsPerRun}/run, ${CONFIG.limits.maxApplicationsPerKeyword}/keyword. AI fallback: ${CONFIG.ai.enabled ? CONFIG.ai.model : "disabled"}.`
  );

  const context = await launchBrowser();
  const page = await getOrCreatePage(context);

  await safeGoto(page, "https://www.naukri.com/mnjuser/homepage");
  await sleep(1500);

  if (/nlogin/i.test(page.url())) {
    console.error("\nNot logged in. Run `npm run login` first, then re-run this.\n");
    await context.close();
    process.exit(1);
  }

  const state = { totalApplied: 0, seenUrls: new Set() };

  try {
    for (const keyword of CONFIG.search.keywords) {
      if (state.totalApplied >= CONFIG.limits.maxApplicationsPerRun) break;
      await processKeyword(page, keyword, state);
    }
  } catch (err) {
    if (err.message === "SECURITY_CHECKPOINT_DETECTED") {
      console.error(
        "\n🚨 Naukri showed a security check/captcha. Stopping immediately — please solve it manually in the open browser window, then re-run.\n"
      );
    } else {
      console.error("\nFatal error:", err);
    }
  }

  console.log("\n========== SUMMARY ==========");
  console.log(`Total handled this run: ${state.totalApplied}`);
  console.log("See ./data/applied-log.json and ./data/needs-review.json for full details.");

  await context.close();
}

main();
