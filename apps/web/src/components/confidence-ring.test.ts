import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

import { ConfidenceRing, sureness } from "./confidence-ring";

test("its colour follows the kind's threshold (the server's confidence), not the percent alone", () => {
  // 80% is under a link's likely threshold (85%) but over a request's (75%).
  expect(sureness({ kind: "links", probability: 0.8, confidence: "maybe" })).toEqual({ percent: 80, likely: false, label: "Not sure: 80% sure" });
  expect(sureness({ kind: "resolves", probability: 0.8, confidence: "likely" })).toEqual({ percent: 80, likely: true, label: "Likely: 80% sure" });
  expect(sureness({ kind: "article_edit", probability: 0.874, confidence: "likely" })?.percent).toBe(87);
  // Just under a request's threshold (75%): its percent mustn't read as the threshold.
  expect(sureness({ kind: "resolves", probability: 0.746, confidence: "maybe" })).toEqual({ percent: 74, likely: false, label: "Not sure: 74% sure" });
  expect(sureness({ kind: "resolves", probability: 0.57, confidence: "maybe" })?.percent).toBe(57);
  // Under 60%: unlikely.
  expect(sureness({ kind: "resolves", probability: 0.599, confidence: "maybe" })?.label).toBe("Unlikely: 59% sure");
  expect(sureness({ kind: "resolves", probability: 0.6, confidence: "maybe" })?.label).toBe("Not sure: 60% sure");
});

test("the changelog line isn't a guess: no ring", () => {
  expect(sureness({ kind: "changelog_line", probability: 1, confidence: "likely" })).toBeNull();
  expect(renderToString(createElement(ConfidenceRing, { update: { kind: "changelog_line", probability: 1, confidence: "likely" } }))).toBe("");
});

test("green when likely, orange when not sure, red when unlikely, and says which in words", () => {
  const likely = renderToString(createElement(ConfidenceRing, { update: { kind: "resolves", probability: 0.9, confidence: "likely" } }));
  expect(likely).toContain('aria-label="Likely: 90% sure"');
  expect(likely).toContain("text-primary");
  expect(likely).toContain('stroke-dasharray="90 100"');
  const unsure = renderToString(createElement(ConfidenceRing, { update: { kind: "resolves", probability: 0.7, confidence: "maybe" } }));
  expect(unsure).toContain('aria-label="Not sure: 70% sure"');
  expect(unsure).toContain("text-highlight-foreground");
  const unlikely = renderToString(createElement(ConfidenceRing, { update: { kind: "resolves", probability: 0.5, confidence: "maybe" } }));
  expect(unlikely).toContain('aria-label="Unlikely: 50% sure"');
  expect(unlikely).toContain("text-destructive");
});

test("a change's, on average: the list's small ring", () => {
  const ring = renderToString(createElement(ConfidenceRing, { sure: { percent: 71, likely: false }, small: true }));
  expect(ring).toContain('aria-label="Not sure: 71% sure on average"');
  expect(ring).toContain("size-7");
});
