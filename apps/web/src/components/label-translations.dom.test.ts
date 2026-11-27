// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/label-translations", () => ({ saveCollectionTranslation: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const { LabelTranslations } = await import("./label-translations");

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
  const render = (keepUpToDate: boolean) => act(async () => root.render(h(LabelTranslations, { kind: "collection", projectSlug: "acme", slug: "billing", defaultName: "English", translations: [german(keepUpToDate)], ai: true })));
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

test("kept up to date but not made: being translated while AI can make it, else not translated", async () => {
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  roots.push(root);
  const waiting = { language: "de", native: "Deutsch", name: null, description: null, keepUpToDate: true };
  const render = (ai: boolean) => act(async () => root.render(h(LabelTranslations, { kind: "collection", projectSlug: "acme", slug: "billing", defaultName: "English", translations: [waiting], ai })));
  await render(true);
  expect(box.textContent).toContain("Being translated: readers see the English name");
  // AI off (or a sample collection): nothing will make it.
  await render(false);
  expect(box.textContent).toContain("Not translated: readers see the English name");
});


test("typing in Description turns Keep up to date off, as typing in Name does", async () => {
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(h(LabelTranslations, { kind: "collection", projectSlug: "acme", slug: "billing", defaultName: "English", translations: [german(true)], ai: true })));
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit Deutsch"]')!.click());
  const keep = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
  expect(keep.checked).toBe(true);
  // Typed, as a browser does: the value set, then its input event.
  const description = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea[name="description"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, "Alles zum Bezahlen.");
    description.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(keep.checked).toBe(false);
});

test("each row says its language to a screen reader (the code chip is for the eye)", async () => {
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(h(CollectionTranslations, { projectSlug: "acme", slug: "billing", defaultName: "English", translations: [german(true)], ai: true })));
  const named = box.querySelector<HTMLElement>("li .sr-only")!;
  expect(named.textContent).toBe("Deutsch");
  expect(named.closest("[aria-hidden]")).toBeNull();
});

test("with AI off (or on a sample collection, where the page passes ai false), the dialog has no Keep up to date", async () => {
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(h(CollectionTranslations, { projectSlug: "acme", slug: "billing", defaultName: "English", translations: [german(false)], ai: false })));
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit Deutsch"]')!.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"] input[type="checkbox"]')).toBeNull();
});

