import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { VisibilityBadge } from "./visibility-badge";

const render = (visibility: "PUBLIC" | "PRIVATE" | "TEAM") => renderToStaticMarkup(createElement(VisibilityBadge, { visibility }));

test("a private post's badge says who sees it in words a screen reader reads, not only on hover; a public post has none", () => {
  expect(render("PRIVATE")).toContain('Private<span class="sr-only">: only its author and the team see it</span>');
  expect(render("TEAM")).toContain('Team only<span class="sr-only">: only the team sees it</span>');
  expect(render("PUBLIC")).toBe("");
});
