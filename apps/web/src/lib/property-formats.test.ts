import { expect, test } from "vitest";

import { formatProperty, isAmount, propertyHeadings, propertyLabel, readableName, storedPropertyFormats, suggestedAsking } from "./property-formats";

const formats = storedPropertyFormats({
  mrr: { label: "MRR", format: "money", currency: "EUR" },
  seats: { format: "number" },
  arr: { format: "money" },
  renews: { format: "date" },
  broken: { format: "sparkles" },
});

test("the team's name for a property, else its key in words", () => {
  expect(propertyLabel(storedPropertyFormats({ seats: { label: "Licensed seats" } }), "seats")).toBe("Licensed seats");
  expect(propertyLabel(formats, "seats")).toBe("Seats");
  // Not one every object has.
  expect(propertyLabel(formats, "constructor")).toBe("Constructor");
});

test("a key in words: the first capitalised, letters in capitals", () => {
  expect(readableName("seats")).toBe("Seats");
  expect(readableName("company_size")).toBe("Company size");
  expect(readableName("companySize")).toBe("Company size");
  expect(readableName("signedUpAt")).toBe("Signed up at");
  expect(readableName("userID")).toBe("User ID");
  expect(readableName("signed-up.at")).toBe("Signed up at");
  expect(readableName("mrr")).toBe("MRR");
  expect(readableName("account_id")).toBe("Account ID");
  expect(readableName("ARPU")).toBe("ARPU");
  expect(readableName("seats_2026")).toBe("Seats 2026");
  // Nothing but separators stays as it is.
  expect(readableName("__")).toBe("__");
});

test("a number with no format is a number; the team's format wins", () => {
  expect(formatProperty({}, "seats", 12345.678)).toBe("12,345.68");
  // A name of the team's own, but no format.
  expect(formatProperty(storedPropertyFormats({ seats: { label: "Seats" } }), "seats", 1200)).toBe("1,200");
  expect(formatProperty(storedPropertyFormats({ account: { format: "text" } }), "account", 1200)).toBe("1200");
  expect(formatProperty({}, "plan", "pro")).toBe("pro");
  // Ids and times show as they are.
  expect(formatProperty({}, "account_id", 1234567)).toBe("1234567");
  expect(formatProperty({}, "createdAt", 1767225600)).toBe("1767225600");
});

test("an amount is a number property that isn't an id, a time, a year, a zip code or a phone number", () => {
  // Whole words only: "format" doesn't end in "at", "years_used" isn't a year; "last" alone isn't a time.
  const amounts = ["seats", "mrr", "company_size", "format", "stats", "paid_seats", "years_used", "last_order_total"];
  expect(amounts.filter(isAmount)).toEqual(amounts);
  const others = ["id", "account_id", "orgId", "userID", "signed_up_at", "createdAt", "updated.at", "renews_on", "start_date"];
  expect(others.filter(isAmount)).toEqual([]);
  expect(["year", "founded_year", "zip", "zip_code", "postalCode", "phone", "last_login", "lastSeen", "login_timestamp", "epoch"].filter(isAmount)).toEqual([]);
  expect(["created", "updated", "signup_time", "trial_end", "current_period_end", "joined", "expires"].filter(isAmount)).toEqual([]);
  // A time word only makes it a time at the end of the key: these are counts.
  expect(["active_users", "login_count", "visit_count", "end_users", "signup_count"].filter(isAmount)).toEqual(["active_users", "login_count", "visit_count", "end_users", "signup_count"]);
  // Shown as they are.
  expect(formatProperty({}, "year", 2026)).toBe("2026");
  expect(formatProperty({}, "zip", 10001)).toBe("10001");
  expect(formatProperty({}, "last_login", 1767225600)).toBe("1767225600");
});

test("Who's asking suggests the first number or money the team set, else the first amount", () => {
  expect(suggestedAsking(["account_id", "arr", "mrr"], {})).toBe("arr");
  // The team's format wins over the key: arr as text and mrr as a date aren't offered, an id set to money is.
  expect(suggestedAsking(["arr", "mrr", "seats"], storedPropertyFormats({ arr: { format: "text" }, mrr: { format: "date" } }))).toBe("seats");
  expect(suggestedAsking(["account_id", "seats"], storedPropertyFormats({ account_id: { format: "money" } }))).toBe("account_id");
  expect(suggestedAsking(["mrr"], storedPropertyFormats({ mrr: { label: "MRR" } }))).toBe("mrr");
  expect(suggestedAsking(["arr"], storedPropertyFormats({ arr: { format: "text" } }))).toBeUndefined();
});

test("properties shown together: two that would read the same show their keys", () => {
  const headings = propertyHeadings(formats, ["plan_name", "planName", "seats", "mrr", "Seats"]);
  expect([...headings.values()]).toEqual(["plan_name", "planName", "seats", "MRR", "Seats"]);
  expect(propertyHeadings(formats, ["plan_name", "seats"]).get("plan_name")).toBe("Plan name");
  // A key shown as it is doesn't read the same as another's heading either: the team calls `tier` "plan_name".
  const named = propertyHeadings(storedPropertyFormats({ tier: { label: "plan_name" } }), ["plan_name", "planName", "tier"]);
  expect([...named.values()]).toEqual(["plan_name", "planName", "tier"]);
  // Nor as a table's own columns.
  expect([...propertyHeadings(formats, ["groups", "plan"], ["Groups", "Votes"]).values()]).toEqual(["groups", "Plan"]);
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
  // Cents below a dollar keep both digits.
  expect(formatProperty(formats, "arr", 0.5)).toBe("$0.50");
  expect(formatProperty(formats, "mrr", 0.1)).toBe("€0.10");
  // A currency without minor units has no decimals: yen.
  const yen = storedPropertyFormats({ mrr: { format: "money", currency: "JPY" } });
  expect(formatProperty(yen, "mrr", 1234.5)).toBe("¥1,235");
  expect(formatProperty(yen, "mrr", 0.5)).toBe("¥1");
  expect(formatProperty(yen, "mrr", 0.2)).toBe("¥0.2");
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
