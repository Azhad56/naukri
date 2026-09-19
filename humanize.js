/**
 * Small toolkit of human-like interaction helpers: randomized delays,
 * organic mouse movement, and character-by-character typing with
 * variable speed. Used throughout apply.js instead of Playwright's
 * instant `.fill()` / `.click()` to avoid the perfectly uniform timing
 * that bot-detection heuristics key off of.
 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function humanDelay(minMs, maxMs) {
  await sleep(randInt(minMs, maxMs));
}

/** Moves the mouse to an element via a few random intermediate points. */
export async function humanMouseMove(page, targetHandleOrLocator) {
  try {
    const box = await targetHandleOrLocator.boundingBox();
    if (!box) return;
    const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
    const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

    const steps = randInt(3, 6);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const jitterX = (Math.random() - 0.5) * 20 * (1 - t);
      const jitterY = (Math.random() - 0.5) * 20 * (1 - t);
      await page.mouse.move(
        targetX * t + jitterX,
        targetY * t + jitterY,
        { steps: randInt(2, 5) }
      );
      await sleep(randInt(15, 60));
    }
    await page.mouse.move(targetX, targetY, { steps: randInt(2, 4) });
  } catch {
    // best-effort only — never fail the flow because of mouse jitter
  }
}

/** Clicks an element after moving the mouse to it organically, with a small pre-click pause. */
export async function humanClick(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanMouseMove(page, locator);
  await sleep(randInt(80, 250));
  await locator.click({ delay: randInt(30, 110) });
}

/** Types text character-by-character with variable, human-like delays. */
export async function humanType(page, locator, text) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanMouseMove(page, locator);
  await locator.click({ delay: randInt(30, 90) });
  // clear existing value first
  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});

  for (const char of String(text)) {
    await page.keyboard.type(char, { delay: randInt(40, 160) });
    if (Math.random() < 0.04) {
      // occasional "thinking" pause, like a real person
      await sleep(randInt(200, 600));
    }
  }
}

/** Scrolls the page/modal by a random small amount, mimicking reading behavior. */
export async function humanScroll(page, locator) {
  try {
    await locator.evaluate((el, amount) => {
      el.scrollBy({ top: amount, behavior: "smooth" });
    }, randInt(120, 320));
    await sleep(randInt(300, 900));
  } catch {
    // ignore
  }
}
