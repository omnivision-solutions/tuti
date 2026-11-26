import { describe, expect, it } from "vitest";

import { ageOf, appendPage, firstRows, initialsOf, latestOnly, lineOf, listPath, type Page, type Row, rowPath, searchAgeOf, spokenAgeOf, withRow } from "./inbox";

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

describe("firstRows", () => {
  const page = (numbers: number[], nextCursor: string | null): Page => ({ conversations: numbers.map((n) => row(n, n)), nextCursor, total: 300 });

  it("fetches one page for a list of a page or less, and as many pages of up to 100 as a longer list shown needs", async () => {
    const asked: string[] = [];
    const get = async <T,>(path: string) => {
      asked.push(path);
      const cursor = Number(/cursor=(\d+)/.exec(path)![1]);
      const limit = Number(/limit=(\d+)/.exec(path)![1]);
      return page(Array.from({ length: limit }, (_, i) => cursor + i), String(cursor + limit)) as T;
    };
    expect((await firstRows(get, "open", "")).conversations).toHaveLength(25);
    expect(asked).toEqual(["/conversations?view=open&limit=25&cursor=0"]);

    asked.length = 0;
    const longer = await firstRows(get, "open", "", 230);
    expect(asked).toEqual(["/conversations?view=open&limit=100&cursor=0", "/conversations?view=open&limit=100&cursor=100", "/conversations?view=open&limit=30&cursor=200"]);
    expect(longer.conversations).toHaveLength(230);
    expect(longer.nextCursor).toBe("230");
  });

  it("stops at the list's end", async () => {
    const get = async <T,>() => page([1, 2, 3], null) as T;
    expect(await firstRows(get, "open", "", 130)).toMatchObject({ nextCursor: null });
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
    // A search finds the AI's among the team's: said, till it's closed.
    expect(searchAgeOf(row(1, 4, { handledBy: "ai" }), NOW)).toBe("With AI · 4m");
    expect(searchAgeOf(row(1, 4, { handledBy: "ai", status: "closed" }), NOW)).toBe("Closed · 4m");
    expect(searchAgeOf(row(1, 4, { handledBy: "team" }), NOW)).toBe("Open · 4m");
    expect(spokenAgeOf(new Date(NOW - 20_000).toISOString(), NOW)).toBe("1 minute ago");
    expect(spokenAgeOf(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 hours ago");
  });

  it("makes initials of a name or an address", () => {
    expect(initialsOf("Maya Chen")).toBe("MC");
    expect(initialsOf("e2e-sam@example.com")).toBe("EE");
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
    // Unless every row of the view is shown: then it's last.
    expect(withRow(rows, 9, row(9, 60), true).map((r) => r.number)).toEqual([3, 2, 1, 9]);
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
