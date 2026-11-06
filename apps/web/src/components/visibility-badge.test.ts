import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { VisibilityBadge } from "./visibility-badge";

const render = (visibility: "PUBLIC" | "PRIVATE" | "TEAM", of?: "post" | "board") => renderToStaticMarkup(createElement(VisibilityBadge, { visibility, of }));

test("a private post's badge says who sees it in words a screen reader reads, not only on hover; a public post has none", () => {
  expect(render("PRIVATE")).toContain('Private<span class="sr-only">: only its author and the team see it</span>');
  expect(render("TEAM")).toContain('Team only<span class="sr-only">: only the team sees it</span>');
  expect(render("PUBLIC")).toBe("");
});

test("a board's badge says what happens to its new posts, not that the board is hidden", () => {
  expect(render("PRIVATE", "board")).toContain('Private<span class="sr-only">: each new post is seen only by its author and the team</span>');
  expect(render("TEAM", "board")).toContain('Team only<span class="sr-only">: only the team sees this board and its posts</span>');
});
