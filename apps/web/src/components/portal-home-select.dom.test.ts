// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const mutate = vi.fn<(input: unknown) => Promise<object>>(async () => ({}));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({ portal: { update: { mutate } } }), errorMessage: String }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

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

test("a picked home page shows as soon as its save is through, before the page brings it", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(PortalHomeSelect, { projectSlug: "acme", home: "feedback" })));
  const trigger = box.querySelector<HTMLElement>('[aria-labelledby="portal-home-label"]')!;
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((each) => each.textContent?.includes("Documentation"))!;
  await act(async () => option.click());
  expect(mutate).toHaveBeenCalledWith({ project: "acme", home: "docs" });
  // The page's own `home` is still Feedback (no refresh yet): what's shown is what was saved.
  expect(trigger.textContent).toContain("Documentation");
});

test("a save that fails says why, and the select goes back to the home that's saved, not the one just picked", async () => {
  mutate.mockRejectedValueOnce(new Error("Couldn't save"));
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(PortalHomeSelect, { projectSlug: "acme", home: "feedback" })));
  const trigger = box.querySelector<HTMLElement>('[aria-labelledby="portal-home-label"]')!;
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((each) => each.textContent?.includes("Documentation"))!;
  await act(async () => option.click());
  expect(toast.error).toHaveBeenCalledWith("Error: Couldn't save");
  expect(toast.success).not.toHaveBeenCalled();
  expect(trigger.textContent).toContain("Feedback");
  expect(trigger.textContent).not.toContain("Documentation");
});
