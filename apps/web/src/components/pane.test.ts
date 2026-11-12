import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { PaneLayout, SectionGroup, SectionLink, SectionPane } from "./pane";

const url = vi.hoisted(() => ({ pathname: "/app/acme/feedback", search: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => url.pathname, useSearchParams: () => new URLSearchParams(url.search) }));

/** The links a section pane marks open, by title. */
function open(pathname: string, search = "") {
  Object.assign(url, { pathname, search });
  const link = (href: string, title: string) => h(SectionLink, { href, children: title });
  const html = renderToStaticMarkup(
    h(PaneLayout, {
      children: h(SectionPane, {
        title: "Feedback",
        children: [
          link("/app/acme/feedback", "All posts"),
          link("/app/acme/feedback?view=mine", "Mine"),
          // Mapped, as an area lists its boards.
          h(SectionGroup, { label: "Boards", children: ["bugs", "ideas"].map((board) => h(SectionLink, { key: board, href: `/app/acme/feedback?board=${board}`, children: board === "bugs" ? "Bug reports" : "Ideas" })) }),
          link("/app/acme/feedback/roadmap", "Roadmap"),
        ],
      }),
    }),
  );
  return [...html.matchAll(/aria-current="page"[^>]*>(?:<[^>]*>)*([^<]+)/g)].map((match) => match[1]);
}

test("a section pane marks one link open: a query view on its URL, else the path's", () => {
  expect(open("/app/acme/feedback")).toEqual(["All posts"]);
  expect(open("/app/acme/feedback", "view=mine&page=2")).toEqual(["Mine"]);
  expect(open("/app/acme/feedback", "board=bugs")).toEqual(["Bug reports"]);
  expect(open("/app/acme/feedback/roadmap")).toEqual(["Roadmap"]);
  expect(open("/app/acme/feedback/12")).toEqual(["All posts"]);
});
