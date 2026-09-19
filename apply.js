/**
 * Naukri.com job-search + apply automation.
 *
 * Logs in via a persisted real Chrome session (see login.js), then for each
 * configured keyword navigates DIRECTLY to Naukri's search-results URL
 * (e.g. https://www.naukri.com/node-dot-js-jobs?k=node.js&experience=4) —
 * this is far more reliable than driving the homepage's animated,
 * click-to-expand search widget, and is exactly the URL Naukri itself
 * lands on after a manual search.
 *
 * Visits each job's detail page directly. Jobs whose CTA is
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
import { humanClick, humanDelay, sleep } from "./humanize.js";
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

export async function detectSecurityCheckpoint(page) {
  const url = page.url();
  if (/captcha|blocked/i.test(url)) return true;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /unusual activity|verify you.?re a human|security check|access denied/i.test(bodyText);
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

/** Naukri's "pretty" URL slug: lowercase, "." -> "-dot-", everything else
 * non-alphanumeric collapses to a single "-". e.g. "Node.js Developer" ->
 * "node-dot-js-developer". The `k=` query param carries the real,
 * unslugified keyword and is what Naukri actually searches on — the slug
 * mostly just needs to be *a* valid-looking path Naukri will accept and
 * redirect from if it's not the exact canonical one. */
function slugifyKeyword(keyword) {
  return keyword
    .toLowerCase()
    .replace(/\./g, "-dot-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildSearchUrl(keyword) {
  const slug = slugifyKeyword(keyword);
  const params = new URLSearchParams({
    k: keyword.toLowerCase(),
    nignbevent_src: "jobsearchDeskGNB",
  });
  if (CONFIG.search.experienceYears) params.set("experience", String(CONFIG.search.experienceYears));
  if (CONFIG.search.location) params.set("l", CONFIG.search.location);
  // Freshness as a URL param (e.g. jobAge=3 → last 3 days) — same as Naukri's
  // own filter query string, no UI clicking needed.
  if (CONFIG.search.jobAge != null && CONFIG.search.jobAge !== "") {
    params.set("jobAge", String(CONFIG.search.jobAge));
  }
  return `https://www.naukri.com/${slug}-jobs?${params.toString()}`;
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

  const searchUrl = buildSearchUrl(keyword);
  console.log(`  [SEARCH] Navigating directly to: ${searchUrl}`);
  await safeGoto(page, searchUrl);
  await humanDelay(2000, 3500);

  if (await detectSecurityCheckpoint(page)) throw new Error("SECURITY_CHECKPOINT_DETECTED");

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
      try {
        await processKeyword(page, keyword, state);
      } catch (err) {
        if (err.message === "SECURITY_CHECKPOINT_DETECTED") throw err;
        console.error(`  [SKIP KEYWORD] "${keyword}" failed: ${err.message}`);
      }
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
