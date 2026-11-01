import { expect, test } from "vitest";

import { ACTIVE_STATUSES, boardStatuses, nextPageHref, parsePostFilters, postOrderBy, TEAM_SORTS } from "./post-filters";

test("defaults to all statuses, most votes, every board", () => {
  expect(parsePostFilters({})).toEqual({ statusParam: "all", status: undefined, sort: "top", board: undefined, page: 1 });
});

test("reads status, sort and board", () => {
  expect(parsePostFilters({ status: "in-progress", sort: "new", board: "bugs" })).toEqual({
    statusParam: "in-progress",
    status: "IN_PROGRESS",
    sort: "new",
    board: "bugs",
    page: 1,
  });
});

test("ignores unknown values and uses the first of repeated ones", () => {
  expect(parsePostFilters({ status: "bogus", sort: "bogus" })).toMatchObject({
    statusParam: "all",
    status: undefined,
    sort: "top",
  });
  expect(parsePostFilters({ status: ["planned", "open"] }).status).toBe("PLANNED");
});

test("status names on Object.prototype aren't statuses", () => {
  expect(parsePostFilters({ status: "toString" })).toMatchObject({ statusParam: "all", status: undefined });
});

test("newest sorts by date, top by votes then date", () => {
  expect(postOrderBy("new")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  expect(postOrderBy("top")).toEqual([{ voteCount: "desc" }, { createdAt: "desc" }, { id: "desc" }]);
});

test("reads how many pages are shown, from the first", () => {
  expect(parsePostFilters({ page: "3" }).page).toBe(3);
  for (const page of ["0", "-1", "1.5", "x", "1e400"]) {
    expect(parsePostFilters({ page }).page).toBe(1);
  }
});

test("Load more keeps the filters and shows a page more", () => {
  const searchParams = { status: "open", sort: "new", page: "2" };
  expect(nextPageHref(searchParams, parsePostFilters(searchParams))).toBe("?status=open&sort=new&page=3");
  expect(nextPageHref({}, parsePostFilters({}))).toBe("?page=2");
});

test("a board lists the ideas not done yet unless asked for a status, or for all of them", () => {
  expect(boardStatuses({})).toEqual(ACTIVE_STATUSES);
  expect(ACTIVE_STATUSES).toEqual(["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS"]);
  expect(boardStatuses({ status: "completed" })).toEqual(["COMPLETED"]);
  expect(boardStatuses({ status: "all" })).toBeUndefined();
  expect(boardStatuses({ status: "bogus" })).toEqual(ACTIVE_STATUSES);
});

test("Trending only where it's offered (the team's Feedback), Most votes elsewhere", () => {
  expect(parsePostFilters({ sort: "trending" }).sort).toBe("top");
  expect(parsePostFilters({ sort: "trending" }, TEAM_SORTS).sort).toBe("trending");
});

test("a portal board's sort: none, an empty one or one it doesn't know is its default, Trending", () => {
  for (const searchParams of [{}, { sort: "" }, { sort: "votes" }]) {
    expect(parsePostFilters(searchParams, TEAM_SORTS, "trending").sort).toBe("trending");
  }
  expect(parsePostFilters({ sort: "new" }, TEAM_SORTS, "trending").sort).toBe("new");
});
