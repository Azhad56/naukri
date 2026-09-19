/**
 * One-time (or whenever your session expires) manual login helper.
 *
 * Opens a real, visible Chrome window at naukri.com. You log in yourself
 * (email/password, OTP, or Google) exactly like a normal human session.
 * Once you land on the logged-in homepage, this script detects it and
 * closes, leaving the session saved in ./data/chrome-profile for
 * apply.js to reuse.
 *
 * Run: npm run login
 */
import { launchBrowser, getOrCreatePage } from "./browser.js";

async function main() {
  const context = await launchBrowser();
  const page = await getOrCreatePage(context);

  console.log("Opening Naukri — please log in manually in the browser window...");
  await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded" });

  console.log("Waiting for you to finish logging in (logged-in homepage)...");
  try {
    await page.waitForURL(/naukri\.com\/mnjuser\/homepage/, { timeout: 5 * 60 * 1000 });
    console.log("\nLogin detected! Session saved to ./data/chrome-profile");
    console.log("You can now run: npm start\n");
  } catch {
    console.log(
      "\nTimed out waiting for login. If you already logged in, just re-run this script or proceed with `npm start` directly.\n"
    );
  }

  await context.close();
}

main().catch((err) => {
  console.error("Fatal error during login setup:", err);
  process.exit(1);
});
