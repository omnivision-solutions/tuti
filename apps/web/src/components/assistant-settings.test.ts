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
    enter: () => act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))),
    button: (name: string) => [...root.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent) === name)!,
    chips: () => [...root.querySelectorAll("li")].map((chip) => chip.textContent),
    // What a screen reader is told happened.
    status: () => root.querySelector('[role="status"]')!.textContent,
    // What the form sends: a field per topic, and the box.
    sent: () => new FormData(root).getAll("offLimits"),
  };
}

afterEach(() => document.body.replaceChildren());

test("saved topics are chips, each a field of the form; Enter adds one, trimmed, and never twice", async () => {
  const { root, box, type, enter, button, chips, sent, status } = await render(["refund"]);
  expect(chips()).toEqual(["refund"]);
  await type("  legal advice ");
  // A chip coming or going tells the form, for "Save changes".
  const changed = vi.fn();
  root.addEventListener("change", changed);
  await enter();
  expect(chips()).toEqual(["refund", "legal advice"]);
  expect(box.value).toBe("");
  expect(changed).toHaveBeenCalledTimes(1);
  // Enter doesn't submit the form.
  await type("pricing");
  // Not the Enter that confirms an input method's candidate: composing, or Safari's after it (key code 229).
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    const confirming = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    await act(async () => void box.dispatchEvent(confirming));
    expect(confirming.defaultPrevented).toBe(false);
    expect(chips()).toEqual(["refund", "legal advice"]);
    expect(box.value).toBe("pricing");
  }
  const pressed = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => void box.dispatchEvent(pressed));
  expect(pressed.defaultPrevented).toBe(true);
  expect(chips()).toEqual(["refund", "legal advice", "pricing"]);
  expect(status()).toBe("Added pricing");
  // One already there, or nothing, adds nothing; one already there stays in the box and is said to be.
  await type("refund");
  await enter();
  expect(box.value).toBe("refund");
  expect(status()).toBe("refund is already there");
  await type("   ");
  await enter();
  expect(chips()).toEqual(["refund", "legal advice", "pricing"]);
  expect(sent()).toEqual(["refund", "legal advice", "pricing", ""]);
  // A comma ends a topic too, typed or pasted (no key press needed), so two topics never become one: what's before
  // each is a chip, never one already there, and the rest stays in the box.
  await type("shipping, refund, , returns");
  expect(chips()).toEqual(["refund", "legal advice", "pricing", "shipping"]);
  expect(box.value).toBe("returns");
  expect(status()).toBe("Added shipping. refund is already there");
  // A pasted list isn't cut at one topic's length; each topic is.
  await type(`returns, ${"x".repeat(70)}, ${"y".repeat(70)}`);
  expect(chips().slice(4)).toEqual(["returns", "x".repeat(60)]);
  expect(box.value).toBe("y".repeat(60));
  await act(async () => button("Remove returns").click());
  await act(async () => button(`Remove ${"x".repeat(60)}`).click());
  await type("");
  expect(document.getElementById(box.getAttribute("aria-describedby")!)!.textContent).toBe("Press Enter or a comma to add a topic");
  await act(async () => button("Remove shipping").click());
  // A topic typed and not added yet is sent with the rest.
  await type("billing");
  expect(sent()).toEqual(["refund", "legal advice", "pricing", "billing"]);
});

test("each chip's button is named for its topic and removes it, with focus moved to the box", async () => {
  const { box, button, chips, sent, status } = await render(["refund", "legal advice"]);
  expect(button("Remove refund").type).toBe("button");
  await act(async () => button("Remove refund").click());
  expect(chips()).toEqual(["legal advice"]);
  expect(document.activeElement).toBe(box);
  expect(status()).toBe("Removed refund");
  expect(sent()).toEqual(["legal advice", ""]);
  await act(async () => button("Remove legal advice").click());
  expect(chips()).toEqual([]);
});

test("at the limit no more can be added, until one is removed", async () => {
  const { box, type, enter, button, chips, sent, status } = await render(["a", "b"], 2);
  expect(box.readOnly).toBe(true);
  expect(box.placeholder).toBe("2 topics is the most");
  await type("c");
  await enter();
  expect(chips()).toEqual(["a", "b"]);
  await act(async () => button("Remove a").click());
  expect(box.readOnly).toBe(false);
  await type("c");
  await enter();
  expect(chips()).toEqual(["b", "c"]);
  // Commas stop at the limit too.
  await act(async () => button("Remove b").click());
  await type("d, e, f");
  expect(chips()).toEqual(["c", "d"]);
  // Nothing is left in the full box, which can't be edited: it would be sent as one topic too many.
  expect(box.value).toBe("");
  expect(status()).toBe("Added d. 2 topics is the most: e, f not added");
  expect(sent()).toEqual(["c", "d", ""]);
});

test("while an input method composes, a comma adds nothing; as the composition ends, the text is read: split at commas, cut to a topic's length", async () => {
  const { box, enter, chips } = await render([]);
  const compose = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    });
  const end = () => act(async () => void box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await compose("a, b");
  expect(chips()).toEqual([]);
  expect(box.value).toBe("a, b");
  await end();
  expect(chips()).toEqual(["a"]);
  expect(box.value).toBe("b");
  await enter();
  // Composed past a topic's length, it's cut as it ends, and by Enter.
  await compose("x".repeat(80));
  await end();
  expect(box.value).toBe("x".repeat(60));
  await compose("y".repeat(80));
  await enter();
  expect(chips()).toEqual(["a", "b", "y".repeat(60)]);
  // A cut never leaves half a character.
  await compose(`${"z".repeat(59)}😀`);
  await end();
  expect(box.value).toBe("z".repeat(59));
});

test("the form has one box for instructions and none for a tone", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = { tone: "" as const, length: "short" as const, instructions: "Cheerful\n\nCall it Acme.", offLimits: ["refund"] };
  await act(async () => createRoot(root).render(h(AssistantSettings, { projectSlug: "acme", settings, limits: { instructions: 2202, topics: 20, topic: 60 } })));
  expect(root.querySelector('[role="radiogroup"]')!.getAttribute("aria-labelledby")).toBe([...root.querySelectorAll("span")].find((span) => span.textContent === "Answer length")!.id);
  expect([...root.querySelectorAll("label")].map((label) => label.textContent)).toEqual(["Short", "Medium", "Detailed", "Instructions", "Off-limits topics"]);
  expect(root.querySelector<HTMLInputElement>('[name="length"]:checked')!.value).toBe("short");
  // No Save of its own: the page's "Save changes" submits it.
  expect(root.querySelector("button[type=submit], button:not([type])")).toBeNull();
  expect(root.querySelector('[name="tone"]')).toBeNull();
  const instructions = root.querySelector<HTMLTextAreaElement>('[name="instructions"]')!;
  expect(instructions.value).toBe("Cheerful\n\nCall it Acme.");
  expect(instructions.maxLength).toBe(2202);
});
