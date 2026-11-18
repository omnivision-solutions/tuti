// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, expect, test, vi } from "vitest";

import type { AiModelSettingProps } from "@/lib/ai-model-setting";

const saveAiModel = vi.hoisted(() => vi.fn(async (): Promise<{ error?: string }> => ({})));
vi.mock("@/server/ai-models", () => ({ saveAiModel }));

const { AiModelSetting } = await import("./ai-model-setting");

const upgrade = (title: string) => ({ title, billingHref: "/app/acme/settings/billing", note: null });
const props: AiModelSettingProps = {
  projectSlug: "acme",
  group: "support",
  saved: "balanced",
  used: "balanced",
  levels: [
    { level: "affordable", name: "Affordable", upgrade: null },
    { level: "balanced", name: "Balanced", upgrade: null },
    { level: "best", name: "Best", upgrade: null },
    { level: "custom", name: "Custom", upgrade: upgrade("Picking your own AI models needs the Business plan.") },
  ],
  summary: "Drafts Claude Haiku 5.5 · Summaries Claude Haiku 5.5",
  notice: null,
  roles: [
    { role: "support_draft", label: "Drafts", model: "", default: "anthropic/claude-haiku-5.5", agent: false },
    { role: "support_summary", label: "Summaries", model: "acme/tiny", default: "anthropic/claude-haiku-5.5", agent: false },
  ],
  listed: [{ id: "acme/tiny", name: "Acme: Tiny", input: 1e-7, output: 4e-7, tools: true }],
  creditsPerDollar: null,
};

async function render(changes: Partial<AiModelSettingProps> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => createRoot(root).render(h(AiModelSetting, { ...props, ...changes })));
  const radio = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent!.startsWith(name))!;
  return { root, radio, checked: () => [...root.querySelectorAll('[role="radio"][aria-checked="true"]')].map((button) => button.textContent) };
}

const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const leave = (input: HTMLInputElement) => act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

afterEach(() => {
  vi.restoreAllMocks();
  saveAiModel.mockClear();
  document.body.replaceChildren();
});

test("the level in use is the one selected, with each role's model in a line; choosing another saves it at once", async () => {
  const confirmed = vi.spyOn(toast, "success");
  const { root, radio, checked } = await render();
  expect([...root.querySelectorAll('[role="radio"]')].map((button) => button.textContent)).toEqual(["Affordable", "Balanced", "Best", "Custom"]);
  expect(checked()).toEqual(["Balanced"]);
  expect(root.textContent).toContain("Drafts Claude Haiku 5.5 · Summaries Claude Haiku 5.5");
  // No role's model is listed off Custom.
  expect(root.querySelector("input")).toBeNull();
  // The one already saved isn't saved again.
  await act(async () => radio("Balanced").click());
  expect(saveAiModel).not.toHaveBeenCalled();
  // While it saves, the segments stay focusable (the one chosen keeps focus) and take no second choice.
  let saved!: (result: { error?: string }) => void;
  saveAiModel.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)));
  radio("Best").focus();
  await act(async () => radio("Best").click());
  expect(saveAiModel).toHaveBeenCalledWith("acme", { levels: { support: "best" } });
  expect([radio("Best").disabled, radio("Best").getAttribute("aria-disabled"), document.activeElement === radio("Best")]).toEqual([false, "true", true]);
  await act(async () => radio("Affordable").click());
  expect(saveAiModel).toHaveBeenCalledTimes(1);
  // Nothing is confirmed until it's saved; then it is, once, in a toast like every setting that saves by itself.
  expect(confirmed).not.toHaveBeenCalled();
  await act(async () => saved({}));
  expect(confirmed.mock.calls).toEqual([["AI model saved"]]);
  expect(radio("Best").hasAttribute("aria-disabled")).toBe(false);
});

test("a level the plan doesn't include looks like the others, names its plan to a screen reader, and opens the upgrade prompt without saving", async () => {
  const { root, radio, checked } = await render();
  const custom = radio("Custom");
  expect(custom.disabled).toBe(false);
  expect(custom.className).toBe(radio("Best").className);
  const description = document.getElementById(custom.getAttribute("aria-describedby")!)!;
  expect([description.textContent, description.hidden]).toEqual(["Picking your own AI models needs the Business plan.", true]);
  expect(radio("Best").hasAttribute("aria-describedby")).toBe(false);
  await act(async () => custom.click());
  expect(saveAiModel).not.toHaveBeenCalled();
  expect(checked()).toEqual(["Balanced"]);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Picking your own AI models needs the Business plan.");
  expect(dialog.querySelector("a")?.getAttribute("href")).toBe("/app/acme/settings/billing");
  expect(root.querySelector("input")).toBeNull();
});

test("Custom lists a model for each role; one picked from the list saves at once, a typed one on leaving the box, and only once", async () => {
  const { root } = await render({ saved: "custom", used: "custom", levels: props.levels.map((level) => ({ ...level, upgrade: null })) });
  const [drafts, summaries] = [...root.querySelectorAll("input")];
  expect([root.querySelector(`label[for="${drafts!.id}"]`)?.textContent, drafts!.value, drafts!.placeholder]).toEqual(["Drafts", "", "anthropic/claude-haiku-5.5"]);
  expect(summaries!.value).toBe("acme/tiny");
  // Leaving a box unchanged saves nothing.
  await leave(summaries!);
  expect(saveAiModel).not.toHaveBeenCalled();
  await type(drafts!, "acme/tiny");
  expect(saveAiModel).toHaveBeenCalledWith("acme", { support_draft: "acme/tiny" });
  await leave(drafts!);
  expect(saveAiModel).toHaveBeenCalledTimes(1);
  // An id the list doesn't have is saved when the box is left (the server checks it); emptied, the role goes back to the server's own.
  await type(summaries!, "acme/other");
  expect(saveAiModel).toHaveBeenCalledTimes(1);
  await leave(summaries!);
  expect(saveAiModel).toHaveBeenLastCalledWith("acme", { support_summary: "acme/other" });
  await type(summaries!, "");
  await leave(summaries!);
  expect(saveAiModel).toHaveBeenLastCalledWith("acme", { support_summary: "" });
  // Typed a letter at a time, an id that's the start of a longer one isn't saved on the way.
  const sentBefore = saveAiModel.mock.calls.length;
  for (const typed of ["acme/tin", "acme/tiny", "acme/tiny-pro"]) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(summaries!, typed);
      summaries!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
  }
  expect(saveAiModel).toHaveBeenCalledTimes(sentBefore);
  await leave(summaries!);
  expect(saveAiModel).toHaveBeenCalledTimes(sentBefore + 1);
  expect(saveAiModel).toHaveBeenLastCalledWith("acme", { support_summary: "acme/tiny-pro" });
  // One the server refused is sent again when asked again.
  saveAiModel.mockResolvedValueOnce({ error: "Couldn't check the models just now. Try again in a moment." });
  await type(summaries!, "acme/later");
  await leave(summaries!);
  // Said under the box, which is marked invalid until it's changed.
  expect([summaries!.getAttribute("aria-invalid"), document.getElementById(summaries!.getAttribute("aria-describedby")!)?.textContent]).toEqual(["true", "Couldn't check the models just now. Try again in a moment."]);
  const calls = saveAiModel.mock.calls.length;
  await act(async () => summaries!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(saveAiModel).toHaveBeenCalledTimes(calls + 1);
  expect(saveAiModel).toHaveBeenLastCalledWith("acme", { support_summary: "acme/later" });
  expect(summaries!.hasAttribute("aria-invalid")).toBe(false);
});

test("a saved level that isn't in use: the one in use is selected, a line says so, and choosing the one in use saves it", async () => {
  const { root, radio, checked } = await render({ saved: "custom", used: "balanced", notice: "Custom isn't available on this plan." });
  expect(checked()).toEqual(["Balanced"]);
  expect(root.textContent).toContain("Custom isn't available on this plan.");
  // Read out with the control: the models in use, and why the level saved isn't the one selected.
  const described = (root.querySelector('[role="radiogroup"]')!.getAttribute("aria-describedby") ?? "").split(" ").map((id) => root.querySelector(`[id="${id}"]`)?.textContent);
  expect(described).toEqual([props.summary, "Custom isn't available on this plan."]);
  expect(root.querySelector("input")).toBeNull();
  await act(async () => radio("Balanced").click());
  expect(saveAiModel).toHaveBeenCalledWith("acme", { levels: { support: "balanced" } });
});

test("a save that throws is over like one refused: the control takes choices again, and the same one can be sent again", async () => {
  const { radio, checked } = await render();
  saveAiModel.mockRejectedValueOnce(new Error("network"));
  await act(async () => radio("Best").click());
  expect(radio("Best").hasAttribute("aria-disabled")).toBe(false);
  // Not saved, so what's in use is still selected.
  expect(checked()).toEqual(["Balanced"]);
  await act(async () => radio("Best").click());
  expect(saveAiModel).toHaveBeenCalledTimes(2);
});

test("a level chosen while a typed model is still saving isn't ignored: it's saved after the model, so the level wins", async () => {
  const { root, radio, checked } = await render({ saved: "custom", used: "custom", levels: props.levels.map((level) => ({ ...level, upgrade: null })) });
  const [drafts] = [...root.querySelectorAll("input")];
  let saved!: (result: { error?: string }) => void;
  saveAiModel.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)));
  // Leaving the box to click a level is what saves the id typed: the click comes while that save is on its way.
  await type(drafts!, "acme/other");
  await leave(drafts!);
  expect(saveAiModel).toHaveBeenCalledTimes(1);
  expect(radio("Best").hasAttribute("aria-disabled")).toBe(false);
  await act(async () => radio("Best").click());
  expect(saveAiModel.mock.calls).toEqual([
    ["acme", { support_draft: "acme/other" }],
    ["acme", { levels: { support: "best" } }],
  ]);
  expect(checked()).toEqual(["Best"]);
  await act(async () => saved({}));
  expect(radio("Best").hasAttribute("aria-disabled")).toBe(false);
});

test("a role switched off (Autopilot's Checks) is said to be off under Custom, with no model to pick", async () => {
  const { root } = await render({
    group: "code_changes",
    saved: "custom",
    used: "custom",
    levels: props.levels.map((level) => ({ ...level, upgrade: null })),
    summary: "Decides Claude Haiku 5.5 · Checks Off · Writes Claude Haiku 5.5",
    roles: [
      { role: "code_changes_decide", label: "Decides", model: "", default: "anthropic/claude-haiku-5.5", agent: true },
      { role: "code_changes_check", label: "Checks", model: "off", default: "anthropic/claude-sonnet-5.5", agent: true },
      { role: "code_changes", label: "Writes", model: "", default: "anthropic/claude-haiku-5.5", agent: true },
    ],
  });
  const boxes = [...root.querySelectorAll("input")];
  expect(boxes.map((input) => root.querySelector(`label[for="${input.id}"]`)?.textContent)).toEqual(["Decides", "Writes"]);
  expect(boxes.map((input) => input.value)).toEqual(["", ""]);
  expect([...root.querySelectorAll("p")].map((line) => line.textContent)).toContain("ChecksOff");
});
