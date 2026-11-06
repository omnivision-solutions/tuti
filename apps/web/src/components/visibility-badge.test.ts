import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { VisibilityBadge } from "./visibility-badge";

/** The badge's text, as a screen reader reads it. */
const read = (visibility: "PUBLIC" | "PRIVATE" | "TEAM") =>
  renderToStaticMarkup(createElement(VisibilityBadge, { visibility }))
    .replace(/<[^>]+>/g, "")
    .trim();

test("a private post's badge says who sees it in words a screen reader reads, not only on hover; a public post has none", () => {
  expect(read("PRIVATE")).toBe("Private: only its author and the team see it");
  expect(read("TEAM")).toBe("Team only: only the team sees it");
  expect(read("PUBLIC")).toBe("");
});
