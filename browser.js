/**
 * Launches a persistent, stealth-patched real Chrome browser context.
 *
 * Using a persistent context (a real on-disk Chrome profile dedicated to
 * this automation) means:
 *  - You log into Naukri manually ONCE via `npm run login`.
 *  - Every later run reuses that real session/cookies — no credential
 *    automation, no password stored anywhere.
 *  - It's the real Chrome binary (channel: "chrome"), not the bundled
 *    Chromium, with the stealth plugin patching the common automation
 *    fingerprints (navigator.webdriver, chrome.runtime, plugins, etc.)
 */
import fs from "node:fs";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { CONFIG } from "./config.js";

chromium.use(StealthPlugin());

export async function launchBrowser() {
  fs.mkdirSync(CONFIG.profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(CONFIG.profileDir, {
    channel: CONFIG.channel,
    headless: CONFIG.headless,
    // viewport: null lets the page fill the real (maximized) OS window
    // instead of being constrained to a fixed content size.
    viewport: null,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
  });

  return context;
}

export async function getOrCreatePage(context) {
  const pages = context.pages();
  return pages.length ? pages[0] : await context.newPage();
}
