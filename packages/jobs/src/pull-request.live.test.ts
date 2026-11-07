import { expect, test } from "vitest";
import { maskSecrets } from "./pull-request";

// By hand (`pnpm test:live`): a wall-clock check, so it stays out of the deterministic suite.
test("masking takes time in step with the text's length, whatever the text", { timeout: 60_000 }, () => {
  // Shapes that made a pattern rescan the rest of the text from each of many starting points.
  const size = 1_000_000;
  const shapes = ["\n", "\r\n", "eyJ-", "eyJaaaaaaaaaaaa.eyJ-", "auth", "a.a.a.a.a.a.a.a.a.a://b:", "-----BEGIN ", 'password="'];
  for (const shape of shapes) {
    const text = shape.repeat(size / shape.length);
    const started = performance.now();
    maskSecrets(text);
    // Milliseconds now; minutes when a pattern rescans.
    expect(performance.now() - started, JSON.stringify(shape)).toBeLessThan(5000);
  }
});
