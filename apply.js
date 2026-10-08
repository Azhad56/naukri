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
 * Q&A bank, with OpenAI as fallback only for unknown screening questions.
 *
 * Prerequisite: run `npm run login` once to save your session.
 * Run: npm start
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { launchBrowser, getOrCreatePage } from "./browser.js";
import { humanClick, humanDelay, humanReviewPage, sleep } from "./humanize.js";
import { handleScreeningQuestionsIfAny } from "./chatbot.js";
import { extractJobDetails, computeMatchScore } from "./jobMatch.js";
import { logResult, alreadyHandled } from "./logger.js";
import { cardPrefix, findNextResultsUrl, jobUrlKey } from "./pagination.js";

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
    const key = jobUrlKey(href, page.url());
    if (!href || seen.has(key)) continue;
    const title = (await a.innerText().catch(() => "")).split("\n")[0].trim();
    if (!title) continue; // filters out non-title anchors that also match the href pattern
    seen.add(key);
    cards.push({ href: new URL(href, page.url()).href, title, key });
  }
  return cards;
}

/** Visits a single job detail page and applies, skips, or handles screening questions.
 * @returns {"applied"|"skipped_company_site"|"skipped"|"failed"} */
async function processJob(page, card, jobContext) {
  const prefix = cardPrefix(jobContext);
  await safeGoto(page, card.href);
  await humanDelay(800, 1400);

  if (await detectSecurityCheckpoint(page)) throw new Error("SECURITY_CHECKPOINT_DETECTED");

  const companySiteBtn = page.getByRole("button", { name: /apply on company site/i }).first();
  if (await companySiteBtn.count().catch(() => 0)) {
    console.log(`${prefix}[SKIP] ${jobContext.title} — requires "Apply on company site"`);
    logResult({ ...jobContext, status: "skipped", reason: "apply_on_company_site" });
    return "skipped_company_site";
  }

  const alreadyAppliedBtn = page.getByText(/^applied$/i).first();
  if (await alreadyAppliedBtn.count().catch(() => 0)) {
    console.log(`${prefix}[SKIP] ${jobContext.title} — already applied previously`);
    logResult({ ...jobContext, status: "skipped", reason: "already_applied" });
    return "skipped";
  }

  const applyBtn = page.getByRole("button", { name: /^apply$/i }).first();
  if (!(await applyBtn.count().catch(() => 0))) {
    console.log(`${prefix}[SKIP] ${jobContext.title} — no direct Apply button found`);
    logResult({ ...jobContext, status: "skipped", reason: "no_apply_button" });
    return "skipped";
  }

  // Extract Job highlights / description / role / key skills and score the
  // match against the resume BEFORE ever clicking Apply — don't burn an
  // application on a job that clearly isn't a fit.
  const jobDetails = await extractJobDetails(page);
  const match = await computeMatchScore(jobDetails, jobContext);
  console.log(
    `${prefix}[MATCH] ${match.score}% (${match.source}${
      match.aiScore != null ? `: keyword=${match.keywordScore}%, ai=${match.aiScore}%` : ""
    })${jobDetails.role ? ` — Role: ${jobDetails.role}` : ""}${
      jobDetails.keySkills.length ? ` — Key Skills: ${jobDetails.keySkills.slice(0, 8).join(", ")}` : ""
    }`
  );
  if (match.score < CONFIG.matching.minMatchPercent) {
    console.log(
      `${prefix}[SKIP] ${jobContext.title} — match ${match.score}% below threshold ${CONFIG.matching.minMatchPercent}%`
    );
    logResult({
      ...jobContext,
      status: "skipped",
      reason: "low_match_score",
      matchScore: match.score,
      matchSource: match.source,
    });
    return "skipped";
  }

  console.log(`${prefix}[REVIEW] Scrolling through the job description before applying...`);
  await humanReviewPage(page);

  console.log(`${prefix}[OPEN] ${jobContext.title}`);
  await humanClick(page, applyBtn);
  await humanDelay(1000, 2000);

  const screeningResult = await handleScreeningQuestionsIfAny(page, jobContext);
  if (screeningResult === "needs_review") {
    logResult({ ...jobContext, status: "needs_review", reason: "chatbot_unresolved" });
    console.log(`${prefix}[NEEDS_REVIEW] ${jobContext.title} — screening question not answered`);
    return "skipped";
  }

  logResult({ ...jobContext, status: "applied", screening: screeningResult });
  console.log(`${prefix}[APPLIED] ${jobContext.title}${screeningResult === "completed" ? " (answered screening questions)" : ""}`);
  return "applied";
}

async function processKeyword(page, keyword, state) {
  console.log(`\n=== Keyword: "${keyword}" ===`);

  const searchUrl = buildSearchUrl(keyword);
  console.log(`  [SEARCH] Navigating directly to: ${searchUrl}`);
  await safeGoto(page, searchUrl);
  await humanDelay(2000, 3500);

  if (await detectSecurityCheckpoint(page)) throw new Error("SECURITY_CHECKPOINT_DETECTED");

  let appliedForKeyword = 0;
  let pageNum = 1;
  while (
    appliedForKeyword < CONFIG.limits.maxApplicationsPerKeyword &&
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

    console.log(`  [PAGE ${pageNum}] Found ${cards.length} job cards.`);

    // Capture pagination before visiting detail pages. Reloading the results
    // page after every card can otherwise lose Naukri's client-side state.
    const nextResultsUrl = await findNextResultsUrl(page);
    let accountedFor = 0;

    for (const [index, card] of cards.entries()) {
      if (appliedForKeyword >= CONFIG.limits.maxApplicationsPerKeyword) break;
      if (state.totalApplied >= CONFIG.limits.maxApplicationsPerRun) break;
      const position = { pageNumber: pageNum, cardNumber: index + 1, cardsOnPage: cards.length };
      const prefix = cardPrefix(position);
      accountedFor += 1;

      if (state.seenUrls.has(card.key)) {
        console.log(`${prefix}[SKIP] ${card.title} — already processed under another keyword this run`);
        continue;
      }
      state.seenUrls.add(card.key);
      if (alreadyHandled(card.href)) {
        console.log(`${prefix}[SKIP] ${card.title} — application already recorded`);
        continue;
      }

      const jobContext = { jobUrl: card.href, title: card.title || "Untitled", keyword, ...position };

      let outcome = "failed";
      try {
        outcome = await processJob(page, card, jobContext);
      } catch (err) {
        if (err.message === "SECURITY_CHECKPOINT_DETECTED") throw err;
        console.error(`${prefix}[FAILED] ${jobContext.title}: ${err.message}`);
        logResult({ ...jobContext, status: "failed", error: err.message });
        continue;
      }

      // "Apply on company site" → move on immediately, no delay and don't
      // burn the per-run application quota / long-break counter on skips.
      if (outcome === "skipped_company_site") continue;

      if (outcome === "applied") {
        appliedForKeyword += 1;
        state.totalApplied += 1;
      }

      if (outcome === "applied" && state.totalApplied > 0 && state.totalApplied % CONFIG.limits.longBreakEvery === 0) {
        const breakMs =
          CONFIG.limits.longBreakMinMs +
          Math.floor(Math.random() * (CONFIG.limits.longBreakMaxMs - CONFIG.limits.longBreakMinMs));
        console.log(`\n[BREAK] Taking a longer human-like break: ${Math.round(breakMs / 1000)}s...\n`);
        await sleep(breakMs);
      } else if (outcome === "applied") {
        await humanDelay(CONFIG.limits.minDelayBetweenJobsMs, CONFIG.limits.maxDelayBetweenJobsMs);
      }
      // Other skips (already applied / no Apply button) also continue without
      // the long between-job delay — only real applications pace the run.
    }

    console.log(`  [PAGE ${pageNum}] Accounted for ${accountedFor}/${cards.length} cards.`);

    if (appliedForKeyword >= CONFIG.limits.maxApplicationsPerKeyword ||
        state.totalApplied >= CONFIG.limits.maxApplicationsPerRun) {
      console.log("Application limit reached; stopping pagination.");
      break;
    }

    if (!nextResultsUrl) {
      console.log("No further result pages.");
      break;
    }
    console.log(`  [PAGE ${pageNum}] Moving to page ${pageNum + 1}: ${nextResultsUrl}`);
    await safeGoto(page, nextResultsUrl);
    await humanDelay(1800, 3200);
    pageNum += 1;
  }

  console.log(`Keyword "${keyword}" done.`);
}

async function main() {
  console.log("Starting Naukri automation...");
  console.log(
    `Limits: ${CONFIG.limits.maxApplicationsPerRun}/run, ${CONFIG.limits.maxApplicationsPerKeyword}/keyword. ` +
    `Job matching: ${CONFIG.matching.useAI && CONFIG.ai.enabled ? `Ollama ${CONFIG.ai.model}` : "keyword-only"}. ` +
    `Unknown screening answers: ${CONFIG.ai.enabled && CONFIG.openai.apiKey ? `OpenAI ${CONFIG.openai.answerModel}` : "manual review (OPENAI_API_KEY missing/AI disabled)"}.`
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
  console.log("See ./data/applied-log.json, ./data/questions-answers.json and ./data/needs-review.json for full details.");

  await context.close();
}

main();
