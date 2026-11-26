import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

// The server action isn't called while rendering.
vi.mock("@/server/inbox", () => ({ retryTranslation: vi.fn() }));

const { MessageTranslation, RetriedTranslations, translationLine } = await import("./message-translation");

type Props = Parameters<typeof MessageTranslation>[0];
const props: Props = { id: "m1", body: "Ich kann mich nicht anmelden.", teamText: null, language: "de", error: null, fromTeam: false, canRetry: true, projectSlug: "acme", number: 1 };
const render = (over: Partial<Props>) => renderToStaticMarkup(createElement(MessageTranslation, { ...props, ...over }));

test("one wrapper around the text in every state, so the text (and focus on it) stays as the line changes", () => {
  for (const over of [{}, { teamText: "I can't sign in." }, { error: "Out of credits" }, { canRetry: false, error: "Out of credits" }]) {
    expect(render(over)).toMatch(/^<div><p tabindex="-1"/);
  }
});

test("a translated message: the translation, its language and Show original", () => {
  const html = render({ teamText: "I can't sign in." });
  expect(html).toContain("I can&#x27;t sign in.");
  expect(html).toContain("Translated from Deutsch");
  expect(html).toContain("Show original");
});

test("a failed translation: as written, why in words, and Try again only where it can run", () => {
  const html = render({ error: "Out of credits" });
  expect(html).toContain("Ich kann mich nicht anmelden.");
  expect(html).toContain("Couldn&#x27;t translate it: Out of credits");
  expect(html).toContain("Try again");
  expect(html).not.toContain("title=");
  // A reason that says it already isn't said twice.
  expect(render({ error: "Couldn't queue its translation" })).toContain("Couldn&#x27;t queue its translation ·");
  // Translation off, or no AI on the server: why, but no Try again.
  const off = render({ error: "Out of credits", canRetry: false });
  expect(off).toContain("Out of credits");
  expect(off).not.toContain("Try again");
});

test("the line: Translating… once Try again queued it, until the translation or a new failure is in", () => {
  expect(translationLine({ teamText: null, error: null, fromTeam: false, retried: false })).toBeNull();
  expect(translationLine({ teamText: null, error: null, fromTeam: false, retried: true })).toBe("translating");
  expect(translationLine({ teamText: null, error: "Out of credits", fromTeam: false, retried: true })).toBe("failed");
  expect(translationLine({ teamText: "Hi", error: null, fromTeam: false, retried: true })).toBe("translated");
  expect(translationLine({ teamText: null, error: null, fromTeam: true, retried: true })).toBeNull();
});

test("Try again's Translating… shows on every message it re-queued, not only the one clicked", () => {
  const retried = (id: string) =>
    renderToStaticMarkup(
      createElement(RetriedTranslations.Provider, { value: { retried: new Set(["m1", "m2"]), markRetried: () => {} } }, createElement(MessageTranslation, { ...props, id })),
    );
  expect(retried("m1")).toContain("Translating…");
  expect(retried("m2")).toContain("Translating…");
  // A message it didn't re-queue (one in the team's language) says nothing.
  expect(retried("m3")).not.toContain("Translating…");
});

test("a re-queued message whose failure is still on the page shows the failure: a retry that fails again isn't hidden", () => {
  const html = renderToStaticMarkup(
    createElement(RetriedTranslations.Provider, { value: { retried: new Set(["m1"]), markRetried: () => {} } }, createElement(MessageTranslation, { ...props, error: "Out of credits" })),
  );
  expect(html).toContain("Out of credits");
  expect(html).not.toContain("Translating…");
});
