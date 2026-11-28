// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({}), errorMessage: String }));

const { PortalHomeSelect } = await import("./portal-home-select");

afterEach(() => document.body.replaceChildren());

test("a new home page from the page (a refresh, another tab) is what the select shows", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(h(PortalHomeSelect, { projectSlug: "acme", home: "feedback" })));
  expect(box.querySelector('[aria-labelledby="portal-home-label"]')?.textContent).toContain("Feedback");
  await act(async () => root.render(h(PortalHomeSelect, { projectSlug: "acme", home: "docs" })));
  expect(box.querySelector('[aria-labelledby="portal-home-label"]')?.textContent).toContain("Documentation");
});
