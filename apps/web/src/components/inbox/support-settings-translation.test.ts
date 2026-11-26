// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, expect, test, vi } from "vitest";

const setTranslation = vi.hoisted(() => vi.fn(async (): Promise<{ error?: string }> => ({})));
vi.mock("@/server/inbox", () => ({ setTranslation }));

const { TranslationSettings } = await import("./support-settings");

async function render(props: { translate?: boolean; teamLanguage?: string } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => createRoot(root).render(h(TranslationSettings, { projectSlug: "acme", translate: false, teamLanguage: "en", ai: true, credits: false, ...props })));
  return { root, toggle: root.querySelector<HTMLInputElement>("#translate-conversations")! };
}

afterEach(() => {
  vi.restoreAllMocks();
  setTranslation.mockReset();
  setTranslation.mockImplementation(async () => ({}));
  document.body.replaceChildren();
});

test("a team language set through the API that isn't offered here is still shown as it is", async () => {
  const { root } = await render({ teamLanguage: "sv" });
  expect(root.querySelector("#team-language")?.textContent).toContain("Svenska");
});

test("while the switch saves it keeps focus and takes no second change; a refused save puts it back and says why", async () => {
  const refused = vi.spyOn(toast, "error");
  let answer!: (result: { error?: string }) => void;
  setTranslation.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  const { toggle } = await render();
  toggle.focus();
  await act(async () => toggle.click());
  expect(setTranslation).toHaveBeenCalledWith("acme", { translate: true });
  expect([toggle.checked, toggle.disabled, toggle.getAttribute("aria-disabled"), document.activeElement === toggle]).toEqual([true, false, "true", true]);
  await act(async () => toggle.click());
  expect(setTranslation).toHaveBeenCalledTimes(1);
  await act(async () => answer({ error: "AI isn't set up on this server" }));
  expect(toggle.checked).toBe(false);
  expect(refused.mock.calls).toEqual([["AI isn't set up on this server"]]);
});
