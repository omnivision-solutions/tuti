import { expect, test } from "vitest";

import { formatProperty, propertyLabel, storedPropertyFormats } from "./property-formats";

const formats = storedPropertyFormats({
  mrr: { label: "MRR", format: "money", currency: "EUR" },
  seats: { format: "number" },
  arr: { format: "money" },
  renews: { format: "date" },
  broken: { format: "sparkles" },
});

test("the team's name for a property, else its own", () => {
  expect(propertyLabel(formats, "mrr")).toBe("MRR");
  expect(propertyLabel(formats, "seats")).toBe("seats");
  // Not one every object has.
  expect(propertyLabel(formats, "constructor")).toBe("constructor");
});

test("values in their format: numbers, money in its currency (dollars unless set), dates; what doesn't fit shows as it is", () => {
  expect(formatProperty(formats, "mrr", 1200)).toBe("€1,200");
  expect(formatProperty(formats, "mrr", 99.5)).toBe("€99.50");
  expect(formatProperty(formats, "arr", 14400)).toBe("$14,400");
  expect(formatProperty(formats, "seats", 12345.678)).toBe("12,345.68");
  // A small one isn't rounded to nothing.
  expect(formatProperty(formats, "seats", 0.004)).toBe("0.004");
  expect(formatProperty(formats, "arr", 0.0042)).toBe("$0.0042");
  expect(formatProperty(formats, "arr", 0)).toBe("$0");
  expect(formatProperty(formats, "renews", 1_790_000_000)).toBe("21 Sept 2026");
  expect(formatProperty(formats, "renews", 1_790_000_000_000)).toBe("21 Sept 2026");
  expect(formatProperty(formats, "renews", "2026-12-01")).toBe("1 Dec 2026");
  expect(formatProperty(formats, "renews", "soon")).toBe("soon");
  // Only text that starts with a day as ISO writes it: "12" isn't one, and a time after it doesn't move the day.
  expect(formatProperty(formats, "renews", "12")).toBe("12");
  expect(formatProperty(formats, "renews", "2026-12-01 00:30")).toBe("1 Dec 2026");
  expect(formatProperty(formats, "renews", "2026-12-01T23:30:00-05:00")).toBe("1 Dec 2026");
  // A day that doesn't exist isn't made into another.
  expect(formatProperty(formats, "renews", "2026-02-30")).toBe("2026-02-30");
  expect(formatProperty(formats, "mrr", "n/a")).toBe("n/a");
  expect(formatProperty(formats, "plan", ["sso", "audit"])).toBe("sso, audit");
  expect(formatProperty(formats, "plan", true)).toBe("true");
  // An unknown format is left out.
  expect(formats.broken).toBeUndefined();
});
