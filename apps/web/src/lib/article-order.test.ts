import { expect, test } from "vitest";

import { inArticleOrder } from "./article-order";

test("articles go by their order, then by title with numbers as numbers", () => {
  const rows = [
    { order: 0, title: "Seeded 10" },
    { order: 1, title: "Alpha" },
    { order: 0, title: "Seeded 2" },
    { order: 0, title: "seeded 1" },
  ];
  expect(inArticleOrder(rows).map((row) => row.title)).toEqual(["seeded 1", "Seeded 2", "Seeded 10", "Alpha"]);
});
