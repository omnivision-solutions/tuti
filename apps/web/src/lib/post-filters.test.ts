import { expect, test } from "vitest";

import { parsePostFilters, postOrderBy } from "./post-filters";

test("defaults to all statuses, most votes, every board", () => {
  expect(parsePostFilters({})).toEqual({ statusParam: "all", status: undefined, sort: "top", board: undefined });
});

test("reads status, sort and board", () => {
  expect(parsePostFilters({ status: "in-progress", sort: "new", board: "bugs" })).toEqual({
    statusParam: "in-progress",
    status: "IN_PROGRESS",
    sort: "new",
    board: "bugs",
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
  expect(postOrderBy("new")).toEqual([{ createdAt: "desc" }]);
  expect(postOrderBy("top")).toEqual([{ voteCount: "desc" }, { createdAt: "desc" }]);
});
