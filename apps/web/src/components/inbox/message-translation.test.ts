import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

// Try again's call (tRPC) isn't made while rendering.
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({}), errorMessage: String }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { MessageTranslation } = await import("./message-translation");

type Props = Parameters<typeof MessageTranslation>[0];
const props: Props = { id: "m1", body: "Ich kann mich nicht anmelden.", teamText: null, language: "de", error: null, fromTeam: false, canRetry: true, projectSlug: "acme", number: 1 };
const render = (over: Partial<Props>) => renderToStaticMarkup(createElement(MessageTranslation, { ...props, ...over }));

test("one wrapper around the text in every state, so the text (and focus on it) stays as the line changes", () => {
  for (const over of [{}, { teamText: "I can't sign in." }, { error: "Out of credits" }, { canRetry: false, error: "Out of credits" }]) {
    expect(render(over)).toMatch(/^<div><p tabindex="-1"/);
  }
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
