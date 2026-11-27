// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/label-translations", () => ({ saveCollectionTranslation: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const { CollectionTranslations } = await import("./label-translations");

/** A collection's settings → Translations: each language's dialog. */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

const german = (keepUpToDate: boolean) => ({ language: "de", native: "Deutsch", name: keepUpToDate ? "Abrechnung" : "Bezahlung", description: "", keepUpToDate });

test("opened again, the dialog's Keep up to date is the row's as it is now, not as it was the last time it opened", async () => {
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  roots.push(root);
  const render = (keepUpToDate: boolean) => act(async () => root.render(h(CollectionTranslations, { projectSlug: "acme", slug: "billing", defaultName: "English", translations: [german(keepUpToDate)], ai: true })));
  const edit = () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit Deutsch"]')!;
  const keep = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
  const cancel = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Cancel")!;
  await render(true);
  await act(async () => edit().click());
  expect(keep().checked).toBe(true);
  await act(async () => cancel().click());
  // Saved as the team's own elsewhere (another tab): this page's refresh brings it.
  await render(false);
  await act(async () => edit().click());
  expect(keep().checked).toBe(false);
});
