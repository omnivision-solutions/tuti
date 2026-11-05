import { expect, test } from "vitest";

import { outlineMarkdown } from "./docs-agent";

test("the outline: a line each, whatever a title or a name holds (a line break would start a heading or an item of its own)", () => {
  const outline = outlineMarkdown({
    collections: [{ id: "c1", slug: "billing", name: "Billing\n## Not a collection", parentId: null }],
    articles: [
      { id: "a1", slug: "invoices", title: "Invoices\n- not-an-article (fake)", publishedAt: new Date(), collectionId: "c1" },
      { id: "a2", slug: "refunds", title: "  Refunds \r\n soon ", publishedAt: null, collectionId: null },
    ],
    waiting: [{ id: "w1", title: "Exports\n\n## Not waiting" }],
    cap: 10,
  });
  expect(outline.split("\n")).toEqual([
    "## Billing ## Not a collection (billing)",
    "- Invoices - not-an-article (fake) (invoices)",
    "## Not in a collection",
    "- Refunds soon (refunds, draft)",
    "## New articles waiting for the team's approval",
    "- Exports ## Not waiting (new:w1)",
  ]);
});
