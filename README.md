# Naukri.com Auto Apply

Standalone Playwright automation for Naukri.com. Uses your real Chrome
profile (logged in once), human-like pacing, a resume-based Q&A bank for
screening questions, local Ollama job-match scoring, and an OpenAI fallback
only for unknown screening questions.

**Jobs whose CTA reads "Apply on company site" are always skipped** —
this bot only applies to jobs with a direct Naukri "Apply" button.

## Setup

```bash
npm install
npx playwright install chrome
cp .env.example .env
# Edit .env with your phone/email/CTC/keywords/experience
```

Make sure [Ollama](https://ollama.com) is running with `llama3.2` if you want
AI-assisted job-match scoring. To answer screening questions that `qaBank.js`
does not recognize, add a newly generated `OPENAI_API_KEY` to `.env`.
Candidate facts and resume text are sent to OpenAI only for those unknown
questions; Responses API storage is disabled.

## Login (once)

```bash
npm run login
```

Log in manually in the Chrome window (email/password, OTP, or Google —
whatever you normally use). Session is saved under `data/chrome-profile/`
(gitignored). Password is never stored.

## Run

```bash
npm start
```

For each keyword in `SEARCH_KEYWORDS` it will:

1. Navigate **directly** to Naukri's search-results URL for that keyword
   (e.g. `https://www.naukri.com/node-dot-js-jobs?k=node.js&experience=5`)
   — the same URL Naukri itself lands on after a manual search. This is far
   more reliable than driving the homepage's animated, click-to-expand
   search widget.
2. Open each job's detail page:
   - **"Apply on company site"** → skipped (external redirect) and logged.
   - Already-applied jobs are detected and skipped.
   - Otherwise, **before ever clicking Apply**, extracts Job highlights /
     description / Role / Key Skills from the page and computes a
     resume-match percentage (see below). Below `MIN_MATCH_PERCENT` →
     skipped and logged (`reason: "low_match_score"`), no application spent.
   - **"Apply"** → clicked; any screening-question widget is answered via
     the Q&A bank / AI fallback, then logged as applied.
3. Paginates through results (`Next`) up to `MAX_PAGES_PER_KEYWORD`.
4. Stops at `MAX_APPLICATIONS_PER_RUN` / `MAX_APPLICATIONS_PER_KEYWORD`, with
   randomized human-like delays and periodic longer breaks throughout.

Filters are applied via the URL (no UI clicking):
`SEARCH_EXPERIENCE_YEARS` → `experience=`, `SEARCH_JOB_AGE` → `jobAge=`
(e.g. `jobAge=3` = last 3 days), `SEARCH_LOCATION` → `l=`.

## Resume-match scoring (`jobMatch.js`)

Before clicking Apply on any job, the bot reads the job's **Job highlights**,
**Job description**, **Role**, and **Key Skills** straight off the detail
page and scores how well it matches your resume/skills:

1. **Keyword overlap** (always on, instant, no dependencies) — compares the
   job's Key Skills chips (or the full job text if chips aren't present)
   against the skills configured in `config.js` (`candidate.skills`).
2. **AI judgment** (optional, `MATCH_USE_AI=true` + Ollama running) — asks
   the local model to holistically rate the job against your resume text,
   averaged in with the keyword score.

Jobs scoring below `MIN_MATCH_PERCENT` (default `30`) are skipped — logged
in `data/applied-log.json` with `reason: "low_match_score"` — **before any
application is spent on them**. Watch the console `[MATCH] ...` line on
each job for the score breakdown.

If Naukri shows a security check/captcha, the run stops immediately so you
can solve it manually.

## Secrets

| What | Where |
|------|--------|
| Email, phone, CTC, etc. | `.env` (gitignored) |
| OpenAI API key | `OPENAI_API_KEY` in `.env` (gitignored) |
| Naukri session | `data/chrome-profile/` (gitignored) |
| Password | Never stored |

## Files

```
apply.js         main search + apply script
login.js         one-time manual login
config.js        loads .env + search/filter/limit settings
qaBank.js        rule-based screening-question answers
aiFallback.js    OpenAI fallback for unknown screening questions
chatbot.js       handles Naukri's optional post-Apply question widget
browser.js / humanize.js / logger.js / resumeText.js / loadEnv.js
.env.example     template for secrets
data/            runtime profile, logs, caches (gitignored)
```

## Screening questions and logs

After Apply, the bot waits for an application confirmation or a screening drawer.
It supports text, numeric, contenteditable, radio, and native dropdown fields,
using the Q&A bank first and OpenAI `gpt-6.1-sol` only when no grounded rule is
available. It waits for Save to become enabled and for the next question before
answering again. A missing or closed drawer alone does not count as a successful
application.

Questions and answers appear in the terminal and data/questions-answers.json,
with the job URL, source, timestamp, and status:

- filled: the answer was entered into the field.
- saved: the next question or application confirmation appeared after Save.

Unresolved questions are recorded in data/needs-review.json, with a screenshot
in data/debug/. Application outcomes remain in data/applied-log.json.

Keep candidate.skills in config.js accurate. Per the configured candidate rules,
an unlisted skill uses `TOTAL_YEARS_EXPERIENCE`. Other unknown questions use
OpenAI; if it cannot provide a grounded answer, the job needs manual review.
Provider/model/context-scoped answers are cached in data/answers-cache.json.
Token usage is recorded without prompts or resume content in
data/openai-usage.json.

Ollama remains responsible for optional job-match scoring. The OpenAI screening
model never participates in match scoring. If `OPENAI_API_KEY` is missing, known
questions and job matching continue, while unknown questions are sent to manual
review.

## Tests

Run npm test (or npm.cmd test in PowerShell if script execution is disabled).
Tests use headless Chrome and local HTML fixtures without logging in or sending
real job applications. They cover field types, iframe drawers, delayed and
multiple questions, Save failures, application confirmation, and Q&A persistence.
OpenAI calls are mocked, so the test suite never needs a key or consumes credits.
