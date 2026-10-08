import test from "node:test";
import assert from "node:assert/strict";
import { cardPrefix, findNextResultsUrl, jobUrlKey } from "../pagination.js";

function fakePage(currentUrl, anchors) {
  return {
    url: () => currentUrl,
    locator: () => ({
      evaluateAll: async (callback) => callback(anchors),
    }),
  };
}

function fakeAnchor({ text = "", href, label = "", rel = "", disabled = false }) {
  const attributes = { href, "aria-label": label, rel, "aria-disabled": disabled ? "true" : null };
  return {
    textContent: text,
    getAttribute: (name) => attributes[name] ?? null,
    classList: { contains: (name) => disabled && name === "disabled" },
  };
}

test("job URL identity ignores tracking parameters", () => {
  assert.equal(
    jobUrlKey("/job-listings-example-123?src=one"),
    jobUrlKey("https://www.naukri.com/job-listings-example-123?src=two")
  );
});

test("card prefix includes page and position", () => {
  assert.equal(cardPrefix({ pageNumber: 2, cardNumber: 7, cardsOnPage: 20 }), "[PAGE 2 | CARD 7/20] ");
});

test("next page URL is captured from the results page before card navigation", async () => {
  const page = fakePage("https://www.naukri.com/node-jobs?k=node", [
    fakeAnchor({ text: "Previous", href: "/node-jobs-1?k=node" }),
    fakeAnchor({ text: "Next", href: "/node-jobs-2?k=node", label: "Next page" }),
  ]);

  assert.equal(await findNextResultsUrl(page), "https://www.naukri.com/node-jobs-2?k=node");
});

test("disabled pagination does not produce a next URL", async () => {
  const page = fakePage("https://www.naukri.com/node-jobs-2", [
    fakeAnchor({ text: "Next", href: "/node-jobs-3", label: "Next page", disabled: true }),
  ]);
  assert.equal(await findNextResultsUrl(page), null);
});
