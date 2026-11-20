// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/server/portal-settings", () => ({ removeRedirect: vi.fn(), saveRedirect: vi.fn() }));

const { RedirectsSettings } = await import("./redirects-settings");

const redirect = (n: number) => ({ id: `r${n}`, from: `/old-${n}`, to: `/new-${n}` });

afterEach(() => document.body.replaceChildren());

test("a redirect gone from the list moves focus to Old address only where focus was lost, not from a control that's still there", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const render = (count: number) => act(async () => root.render(h(RedirectsSettings, { projectSlug: "acme", max: 200, redirects: Array.from({ length: count }, (_, i) => redirect(i)) })));
  await render(3);
  const oldAddress = document.getElementById("redirect-from");
  // A teammate deleted one while focus is on a control that stays: it stays there.
  outside.focus();
  await render(2);
  expect(document.activeElement).toBe(outside);
  // This person deleted one, and the ⋯ that had focus went with its row (focus fell to the page): it goes to Old address.
  outside.blur();
  expect(document.activeElement).toBe(document.body);
  await render(1);
  expect(document.activeElement).toBe(oldAddress);
});
