import { expect, test } from "vitest";

import { stripQuotes } from "./email-quotes";

// By hand (`pnpm test:live`): a wall-clock check, so it stays out of the deterministic suite.
test("cutting the quote takes time in step with the message's length", { timeout: 60_000 }, () => {
  for (const text of [`Hello\n${">\n".repeat(100_000)}Not quoted`, `Hello\n${">\n".repeat(100_000)}`, "Hello\n".repeat(100_000), `Hello\n${"> earlier\n".repeat(500_000)}`]) {
    const started = performance.now();
    stripQuotes(text);
    // Milliseconds now; seconds when each quoted line rescans the rest.
    expect(performance.now() - started).toBeLessThan(1000);
  }
});
