/** Stable identity for a Naukri job. Tracking query parameters vary between
 * searches, while the job-listing path identifies the actual job. */
export function jobUrlKey(href, baseUrl = "https://www.naukri.com/") {
  try {
    const url = new URL(href, baseUrl);
    return `${url.origin}${url.pathname}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return String(href || "").trim().toLowerCase();
  }
}

export function cardPrefix({ pageNumber, cardNumber, cardsOnPage } = {}) {
  if (!pageNumber || !cardNumber) return "";
  return `[PAGE ${pageNumber} | CARD ${cardNumber}/${cardsOnPage || "?"}] `;
}

/** Read the next-page destination while the listing is still intact. */
export async function findNextResultsUrl(page) {
  const currentUrl = page.url();
  const href = await page
    .locator("a[href]")
    .evaluateAll((anchors) => {
      const candidates = anchors.filter((anchor) => {
        const text = (anchor.textContent || "").trim();
        const label = (anchor.getAttribute("aria-label") || "").trim();
        const rel = (anchor.getAttribute("rel") || "").trim();
        const disabled =
          anchor.classList.contains("disabled") || anchor.getAttribute("aria-disabled") === "true";
        return !disabled && (/^next$/i.test(text) || /next/i.test(label) || /\bnext\b/i.test(rel));
      });
      return candidates.at(-1)?.getAttribute("href") || null;
    })
    .catch(() => null);

  if (!href || /^javascript:/i.test(href)) return null;
  try {
    const nextUrl = new URL(href, currentUrl).href;
    return nextUrl === currentUrl ? null : nextUrl;
  } catch {
    return null;
  }
}

