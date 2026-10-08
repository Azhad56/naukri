import test from "node:test";
import assert from "node:assert/strict";
import { humanReviewPage } from "../humanize.js";

test("review scroll advances through the full page before Apply", async () => {
  let scrollY = 0;
  const scrollHeight = 2600;
  const viewportHeight = 600;
  const deltas = [];
  const page = {
    evaluate: async () => ({ scrollY, scrollHeight, viewportHeight }),
    mouse: {
      wheel: async (_x, y) => {
        deltas.push(y);
        scrollY = Math.min(scrollHeight - viewportHeight, scrollY + y);
      },
    },
  };

  await humanReviewPage(page, { minPauseMs: 0, maxPauseMs: 0, maxSteps: 20 });

  assert.ok(deltas.length > 1);
  assert.equal(scrollY, scrollHeight - viewportHeight);
});
