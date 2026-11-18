// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/server/assistant", () => ({ saveAssistantSettings: vi.fn(async () => ({})) }));

const { AssistantSettings, OffLimitsTopics } = await import("./assistant-settings");

async function render(saved: string[], max = 20) {
  const root = document.createElement("form");
  document.body.append(root);
  await act(async () => createRoot(root).render(h(OffLimitsTopics, { saved, max, maxLength: 60 })));
  const box = root.querySelector<HTMLInputElement>("#assistant-off-limits")!;
  const type = (text: string) =>
    act(async () => {
      // React tracks the value it set: the prototype's setter gets a typed one past it.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return {
    root,
    box,
    type,
    button: (name: string) => [...root.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent) === name)!,
    chips: () => [...root.querySelectorAll("li")].map((chip) => chip.textContent),
    // What the form sends: a field per topic, and the box.
    sent: () => new FormData(root).getAll("offLimits"),
  };
}

afterEach(() => document.body.replaceChildren());

test("saved topics are chips, each a field of the form; Add and Enter add one, trimmed, and never twice", async () => {
  const { box, type, button, chips, sent } = await render(["refund"]);
  expect(chips()).toEqual(["refund"]);
  await type("  legal advice ");
  await act(async () => button("Add").click());
  expect(chips()).toEqual(["refund", "legal advice"]);
  expect(box.value).toBe("");
  // Enter adds too, and doesn't submit the form.
  await type("pricing");
  // Not the Enter that confirms an input method's candidate: composing, or Safari's after it (key code 229).
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    const confirming = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    await act(async () => void box.dispatchEvent(confirming));
    expect(confirming.defaultPrevented).toBe(false);
    expect(chips()).toEqual(["refund", "legal advice"]);
    expect(box.value).toBe("pricing");
  }
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => void box.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(true);
  expect(chips()).toEqual(["refund", "legal advice", "pricing"]);
  // One already there, or nothing, adds nothing.
  await type("refund");
  await act(async () => button("Add").click());
  await type("   ");
  await act(async () => button("Add").click());
  expect(chips()).toEqual(["refund", "legal advice", "pricing"]);
  expect(sent()).toEqual(["refund", "legal advice", "pricing", ""]);
  // A topic typed and not added yet is sent with the rest.
  await type("billing");
  expect(sent()).toEqual(["refund", "legal advice", "pricing", "billing"]);
});

test("each chip's button is named for its topic and removes it, with focus moved to the box", async () => {
  const { box, button, chips, sent } = await render(["refund", "legal advice"]);
  expect(button("Remove refund").type).toBe("button");
  await act(async () => button("Remove refund").click());
  expect(chips()).toEqual(["legal advice"]);
  expect(document.activeElement).toBe(box);
  expect(sent()).toEqual(["legal advice", ""]);
  await act(async () => button("Remove legal advice").click());
  expect(chips()).toEqual([]);
});

test("at the limit no more can be added, until one is removed", async () => {
  const { box, type, button, chips } = await render(["a", "b"], 2);
  expect(box.readOnly).toBe(true);
  expect(box.placeholder).toBe("2 topics is the most");
  expect(button("Add").getAttribute("aria-disabled") ?? String(button("Add").disabled)).toBe("true");
  await act(async () => button("Remove a").click());
  expect(box.readOnly).toBe(false);
  await type("c");
  await act(async () => button("Add").click());
  expect(chips()).toEqual(["b", "c"]);
});

test("the form has one box for instructions and none for a tone", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = { tone: "" as const, length: "short" as const, instructions: "Cheerful\n\nCall it Acme.", offLimits: ["refund"] };
  await act(async () => createRoot(root).render(h(AssistantSettings, { projectSlug: "acme", settings, limits: { instructions: 2202, topics: 20, topic: 60 } })));
  expect([...root.querySelectorAll("label, legend")].map((label) => label.textContent)).toEqual(["Answer length", "Short", "Medium", "Detailed", "Instructions", "Off-limits topics"]);
  expect(root.querySelector('[name="tone"]')).toBeNull();
  const instructions = root.querySelector<HTMLTextAreaElement>('[name="instructions"]')!;
  expect(instructions.value).toBe("Cheerful\n\nCall it Acme.");
  expect(instructions.maxLength).toBe(2202);
});
