// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { PaneHeader, PaneLayout, SectionLink, SectionPane } from "./pane";

const url = vi.hoisted(() => ({ pathname: "/app/acme/feedback", search: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => url.pathname, useSearchParams: () => new URLSearchParams(url.search) }));
vi.mock("next/link", () => ({ default: (props: object) => h("a", props) }));
// The section pane's visibility, as the shell's container query would change it.
const observers = vi.hoisted(() => [] as ((entries: { contentRect: { width: number } }[]) => void)[]);
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
      observers.push(callback);
    }
    observe() {}
    disconnect() {}
  },
);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.body.appendChild(document.createElement("div"));
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));
// No page loads: a click on a link only runs the app's handlers.
document.addEventListener("click", (event) => event.preventDefault(), true);

const render = (pathname: string) =>
  act(async () => {
    url.pathname = pathname;
    root.render(
      h(PaneLayout, {
        children: [
          h(SectionPane, { key: "menu", title: "Feedback", children: [h(SectionLink, { key: "all", href: "/app/acme/feedback", children: "All posts" }), h(SectionLink, { key: "roadmap", href: "/app/acme/feedback/roadmap", children: "Roadmap" })] }),
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
  await act(async () => observers.at(-1)!([{ contentRect: { width: 0 } }]));
  expect(drawer()).not.toBeNull();
  await act(async () => observers.at(-1)!([{ contentRect: { width: 248 } }]));
  expect(drawer()).toBeNull();
});
