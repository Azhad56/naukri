# Naukri.com Auto Apply

Standalone Playwright automation for Naukri.com. Uses your real Chrome
profile (logged in once), human-like pacing, a resume-based Q&A bank for any
screening questions, and optional local Ollama fallback for unknown
questions.

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
AI answers for unrecognized screening questions (local only, resume data
never leaves your machine).

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
   - **"Apply"** → clicked; any screening-question widget is answered via
     the Q&A bank / AI fallback, then logged as applied.
   - Already-applied jobs are detected and skipped.
3. Paginates through results (`Next`) up to `MAX_PAGES_PER_KEYWORD`.
4. Stops at `MAX_APPLICATIONS_PER_RUN` / `MAX_APPLICATIONS_PER_KEYWORD`, with
   randomized human-like delays and periodic longer breaks throughout.

Note: `SEARCH_FRESHNESS` / `SEARCH_SORT_BY` in `.env` are currently unused —
filters/sort are intentionally skipped for reliability (the UI widgets for
these were the main source of flakiness). Only `SEARCH_KEYWORDS`,
`SEARCH_EXPERIENCE_YEARS`, and `SEARCH_LOCATION` affect the search URL.

If Naukri shows a security check/captcha, the run stops immediately so you
can solve it manually.

## Secrets

| What | Where |
|------|--------|
| Email, phone, CTC, etc. | `.env` (gitignored) |
| Naukri session | `data/chrome-profile/` (gitignored) |
| Password | Never stored |

## Files

```
apply.js         main search + apply script
login.js         one-time manual login
config.js        loads .env + search/filter/limit settings
qaBank.js        rule-based screening-question answers
aiFallback.js    local Ollama fallback
chatbot.js       handles Naukri's optional post-Apply question widget
browser.js / humanize.js / logger.js / resumeText.js / loadEnv.js
.env.example     template for secrets
data/            runtime profile, logs, caches (gitignored)
```

## Note on the screening-question widget

The recorded walkthrough this automation was built from never triggered
Naukri's chatbot-style screening-question widget (most jobs applied
instantly). `chatbot.js` handles it defensively with broad, text/role-based
selectors — watch the console `[CHATBOT] ...` output on your first real
run and tighten the selectors in `chatbot.js` if your account sees a
differently-structured widget.
