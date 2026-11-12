// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { PaneHeader, PaneLayout, SectionLink, SectionPane } from "./pane";

const url = vi.hoisted(() => ({ pathname: "/app/acme/feedback", search: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => url.pathname, useSearchParams: () => new URLSearchParams(url.search) }));
vi.mock("next/link", () => ({ default: (props: object) => h("a", props) }));
// The section pane's visibility, as the shell's container query would change it.
type Resized = (entries: { contentRect: { width: number } }[]) => void;
const observed = new Map<Element, Resized>();
vi.stubGlobal(
  "ResizeObserver",
  class {
    target?: Element;
    constructor(private callback: Resized) {}
    observe(target: Element) {
      this.target = target;
      observed.set(target, this.callback);
    }
    disconnect() {
      if (this.target) observed.delete(this.target);
    }
  },
);
/** The section pane on the page now shown (`width`) or hidden beside it. */
const paneWidth = (width: number) =>
  act(async () => {
    const pane = document.querySelector("[data-slot=section-pane]")!;
    observed.get(pane)!([{ contentRect: { width } }]);
  });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.body.appendChild(document.createElement("div"));
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));
// No page loads: a click on a link only runs the app's handlers.
document.addEventListener("click", (event) => event.preventDefault(), true);

const render = (pathname: string, menu = "menu") =>
  act(async () => {
    url.pathname = pathname;
    root.render(
      h(PaneLayout, {
        children: [
          menu && h(SectionPane, { key: menu, title: "Feedback", children: [h(SectionLink, { key: "all", href: "/app/acme/feedback", children: "All posts" }), h(SectionLink, { key: "roadmap", href: "/app/acme/feedback/roadmap", children: "Roadmap" })] }),
          h(PaneHeader, { key: "header", title: "All posts" }),
        ],
      }),
    );
  });
const drawer = () => document.querySelector('[role="dialog"]');
const openMenu = () => act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Open the menu"]')!.click());
const clickRoadmap = (init: MouseEventInit) =>
  act(async () => drawer()!.querySelector('a[href="/app/acme/feedback/roadmap"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })));

test("the drawer closes as the URL moves, and stays closed on coming back", async () => {
  await render("/app/acme/feedback");
  await openMenu();
  expect(drawer()).not.toBeNull();
  await render("/app/acme/feedback/12");
  expect(drawer()).toBeNull();
  await render("/app/acme/feedback");
  expect(drawer()).toBeNull();
});

test("a link picked in the drawer closes it, one opened in a new tab doesn't", async () => {
  await render("/app/acme/feedback");
  await openMenu();
  await clickRoadmap({ metaKey: true });
  expect(drawer()).not.toBeNull();
  await clickRoadmap({});
  expect(drawer()).toBeNull();
});

test("the drawer closes as the section pane shows beside the page", async () => {
  await render("/app/acme/feedback");
  await openMenu();
  await paneWidth(0);
  expect(drawer()).not.toBeNull();
  await paneWidth(248);
  expect(drawer()).toBeNull();
});

test("a section pane that comes later, or replaces another, is watched too", async () => {
  await render("/app/acme/feedback", "");
  await render("/app/acme/feedback", "first");
  await openMenu();
  await paneWidth(248);
  expect(drawer()).toBeNull();
  await render("/app/acme/feedback", "second");
  await openMenu();
  await paneWidth(248);
  expect(drawer()).toBeNull();
  expect(observed.size).toBe(1);
});
