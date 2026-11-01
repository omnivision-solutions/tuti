import { expect, test } from "vitest";

import { asking, askingTotal, firstLine, initial, rowLine, shortDuration, subjectFrom, timeAgo } from "./format";

const now = new Date("2026-10-18T12:00:00Z");
const ago = (seconds: number) => timeAgo(new Date(now.getTime() - seconds * 1000), now);

test.each([
  [10, "just now"],
  [60, "1 minute ago"],
  [2 * 3600, "2 hours ago"],
  [24 * 3600, "yesterday"],
  [3 * 24 * 3600, "3 days ago"],
  [14 * 24 * 3600, "2 weeks ago"],
  [400 * 24 * 3600, "last year"],
])("%i seconds → %j", (seconds, text) => {
  expect(ago(seconds)).toBe(text);
});

test.each([
  [30, "1m"],
  [45 * 60, "45m"],
  [3 * 3600 + 59 * 60, "3h"],
  [49 * 3600, "2d"],
])("shortDuration: %i seconds → %j", (seconds, text) => {
  expect(shortDuration(new Date(now.getTime() - seconds * 1000), now)).toBe(text);
});

test("Who's asking: totals with up to two decimals, small ones with their digits", () => {
  expect(asking(1500.5, "mrr")).toBe("1,500.5 mrr");
  expect(asking(12400, "mrr")).toBe("12,400 mrr");
  expect(asking(0.004, "mrr")).toBe("0.004 mrr");
  expect(asking(0.12345, "seats")).toBe("0.123 seats");
  // In the team's name and format for it.
  expect(asking(12400, "mrr", { mrr: { label: "MRR", format: "money" } })).toBe("$12,400 MRR");
  expect(asking(12400.5, "seats", { seats: { format: "number" } })).toBe("12,400.5 seats");
  // The number on its own, for a column headed with the property (Companies): a small one kept too.
  expect(askingTotal(0.004, "mrr")).toBe("0.004");
  expect(askingTotal(12400, "mrr", { mrr: { format: "money" } })).toBe("$12,400");
});

test("a message's first line with something on it, cut short past 140 characters, never through an emoji; a name's initial whole", () => {
  expect(firstLine("\n  \nHello there\nsecond")).toBe("Hello there");
  expect(firstLine("  ")).toBeUndefined();
  const long = "🦜".repeat(150);
  expect(firstLine(long)).toBe(`${"🦜".repeat(139)}…`);
  expect(firstLine("x".repeat(140))).toBe("x".repeat(140));
  expect(initial("🦜 Polly")).toBe("🦜");
  // Flags and joined emoji are one character each, as seen.
  expect(firstLine("🇳🇿".repeat(150))).toBe(`${"🇳🇿".repeat(139)}…`);
  expect(initial("👩🏽‍💻 Ada")).toBe("👩🏽‍💻");
  expect(initial("sam")).toBe("S");
});

test("an Inbox row's line beside its subject: not when the subject is it, or was made from it; shown when a subject someone wrote only starts like it", () => {
  const long = `https://example.com/reports/export?id=${"8f3c2a91".repeat(10)}`;
  // Made from it (cut at 80): not said twice.
  expect(rowLine(subjectFrom(long), long)).toBeUndefined();
  expect(rowLine("Help", "Help")).toBeUndefined();
  // A long subject that is the message itself (an AI question passed to the team): not said twice, cut or not.
  const question = `How do I ${"export a very long report ".repeat(9)}?`;
  expect(rowLine(question, `${question}\n\nThey'd like it by Friday`)).toBeUndefined();
  // A subject someone wrote, ending in "…", and a message going on from it: shown.
  expect(rowLine("Billing…", "Billing page shows the wrong total")).toBe("Billing page shows the wrong total");
  expect(rowLine("Can't export", "The button does nothing\nOn reports")).toBe("The button does nothing");
});
