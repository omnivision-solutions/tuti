import { describe, expect, it } from "vitest";

import { ageOf, appendPage, initialsOf, latestOnly, lineOf, listPath, type Row, rowPath, searchAgeOf, spokenAgeOf, withRow } from "./inbox";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const row = (number: number, minutesAgo: number, more: Partial<Row> = {}): Row => ({
  number,
  subject: `Subject ${number}`,
  status: "open",
  user: { name: "Maya Chen", email: "e2e-maya@example.com" },
  assignee: null,
  lastMessageAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  company: null,
  unread: false,
  latestMessage: null,
  match: null,
  ...more,
});
const message = (more: Partial<NonNullable<Row["latestMessage"]>>) => ({ author: "user" as const, name: null, fromYou: false, fromAddress: null, line: "Thanks!", ...more });

describe("the list's requests", () => {
  it("lists a view, or searches every view, a page at a time", () => {
    expect(listPath({ view: "mine" })).toBe("/conversations?view=mine&limit=25&cursor=0");
    expect(listPath({ view: "mine", q: "refund & tax", cursor: "25" })).toBe("/conversations?q=refund%20%26%20tax&limit=25&cursor=25");
    expect(rowPath("open", 12)).toBe("/conversations?view=open&q=%2312&limit=100");
  });
});

describe("a row's text", () => {
  it("says who wrote the latest message when it isn't the person, as the web's row does", () => {
    expect(lineOf(row(1, 1, { latestMessage: message({}) }))).toBe("Thanks!");
    expect(lineOf(row(1, 1, { latestMessage: message({ author: "team", name: "Olive Park", fromYou: true }) }))).toBe("You: Thanks!");
    expect(lineOf(row(1, 1, { latestMessage: message({ author: "team", name: "Ravi Shah" }) }))).toBe("Ravi: Thanks!");
    expect(lineOf(row(1, 1, { latestMessage: message({ author: "ai" }) }))).toBe("AI: Thanks!");
    expect(lineOf(row(1, 1, { latestMessage: message({ author: "tuti" }) }))).toBe("Tuti: Thanks!");
    expect(lineOf(row(1, 1, { latestMessage: message({ fromAddress: "e2e-cc@example.com" }) }))).toBe("e2e-cc@example.com: Thanks!");
    expect(lineOf(row(1, 1, { latestMessage: message({ line: null }) }))).toBeNull();
  });

  it("shows the match in a search, a note's said so", () => {
    expect(lineOf(row(1, 1, { latestMessage: message({}), match: { note: true, snippet: "…the refund…" } }))).toBe("Note: …the refund…");
  });

  it("says how long ago, short, and the status in a search", () => {
    expect(ageOf(new Date(NOW - 20_000).toISOString(), NOW)).toBe("1m");
    expect(ageOf(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe("59m");
    expect(ageOf(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h");
    expect(ageOf(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe("2d");
    expect(searchAgeOf(row(1, 4, { status: "closed" }), NOW)).toBe("Closed · 4m");
    expect(spokenAgeOf(new Date(NOW - 20_000).toISOString(), NOW)).toBe("1 minute ago");
    expect(spokenAgeOf(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 hours ago");
  });

  it("makes initials of a name or an address", () => {
    expect(initialsOf("Maya Chen")).toBe("MC");
    expect(initialsOf("sam@example.com")).toBe("SE");
    expect(initialsOf("Élodie")).toBe("É");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("the rows shown", () => {
  it("adds a page without the rows it repeats", () => {
    expect(appendPage([row(3, 1), row(2, 2)], [row(2, 2), row(1, 3)]).map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it("puts a changed conversation in its place, a new one first, and drops one that left the view", () => {
    const rows = [row(3, 1), row(2, 5), row(1, 10)];
    expect(withRow(rows, 1, row(1, 0)).map((r) => r.number)).toEqual([1, 3, 2]);
    expect(withRow(rows, 9, row(9, 0)).map((r) => r.number)).toEqual([9, 3, 2, 1]);
    expect(withRow(rows, 2, row(2, 5, { unread: true }))[1]!.unread).toBe(true);
    expect(withRow(rows, 2, null).map((r) => r.number)).toEqual([3, 1]);
    // Older than every row shown: on a page not loaded yet.
    expect(withRow(rows, 9, row(9, 60)).map((r) => r.number)).toEqual([3, 2, 1]);
  });
});

describe("latestOnly", () => {
  it("knows a load a newer one replaced", () => {
    const loads = latestOnly();
    const first = loads.start();
    const second = loads.start();
    expect(loads.isLatest(first)).toBe(false);
    expect(loads.isLatest(second)).toBe(true);
    expect(loads.current()).toBe(second);
  });
});
