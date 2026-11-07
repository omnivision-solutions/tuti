import { expect, test } from "vitest";

import { htmlAsText, MAX_HTML } from "./email-text";

/** What nests in a way the library goes over again at each level. */
const NESTING = ["<blockquote>Earlier", "<ul><li>Earlier", "<ol><li>Earlier", '<a href="https://acme.example/">Earlier', "<h1>Earlier"];

// By hand (`pnpm test:live`): a wall-clock check, so it stays out of the deterministic suite.
test("HTML becomes text in time that grows with the HTML, however deep it nests", { timeout: 60_000 }, () => {
  for (const level of NESTING) {
    for (const depth of [5, 199, 5000]) {
      const open = level.repeat(depth);
      const html = open + "w ".repeat(Math.floor((MAX_HTML - open.length) / 2));
      const started = performance.now();
      htmlAsText(html);
      // Under a second now; minutes, or out of memory, when each level goes over all it holds again.
      expect(performance.now() - started, `${level} ${depth} deep`).toBeLessThan(5000);
    }
  }
});
