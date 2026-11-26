import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@/server/inbox", () => ({ setTranslation: async () => ({}) }));

const { TranslationSettings } = await import("./support-settings");

/** Settings → Inbox's Translate conversations switch, as markup. */
const translation = (props: { translate: boolean; ai: boolean; credits?: boolean }) => {
  const html = renderToStaticMarkup(createElement(TranslationSettings, { projectSlug: "p", teamLanguage: "en", credits: false, ...props }));
  return { html, switch: html.match(/<[^>]*id="translate-conversations"[^>]*>/)?.[0] ?? "" };
};

test("without AI on the server, Translate conversations can't be turned on, and says why; on, it can still be turned off", () => {
  const off = translation({ translate: false, ai: false });
  expect(off.switch).toMatch(/ disabled=""/);
  expect(off.html).toContain("Needs AI, which isn&#x27;t set up on this server.");
  const on = translation({ translate: true, ai: false });
  expect(on.switch).not.toMatch(/ disabled=""/);
  expect(on.html).toContain("Needs AI");
  // With AI it can be turned on; what it costs only where credits are on.
  const ai = translation({ translate: false, ai: true });
  expect(ai.switch).not.toMatch(/ disabled=""/);
  expect(ai.html).not.toContain("Uses AI credits");
  expect(translation({ translate: false, ai: true, credits: true }).html).toContain("Uses AI credits.");
});
