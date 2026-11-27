// @vitest-environment happy-dom
import type { Editor } from "@tiptap/react";
import { act, createElement as h, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const rewriteText = vi.fn();
vi.mock("@/server/rewrite", () => ({ rewriteText }));
const toast = Object.assign(vi.fn(), { error: vi.fn() });
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/upload-image", () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }));
vi.mock("@/server/images", () => ({ generateImage: vi.fn() }));
vi.mock("@/server/media", () => ({ uploadStatus: vi.fn() }));

const { RichEditor } = await import("./rich-editor");

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = { type: "doc", content: [paragraph("Exports are quick."), paragraph("They run in the background and email you when done.")] };
// "They run in the background": the second paragraph's first words.
const SECOND = doc.content[0]!.content[0]!.text.length + 3;
const askAi = { projectSlug: "acme", kind: "changelog" as const, entry: 7, paused: false };

/** A promise the test settles: the AI's answer, when the test says. */
function answer() {
  let settle!: (value: unknown) => void;
  rewriteText.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
  return (value: unknown) => act(async () => settle(value));
}

beforeEach(() => {
  toast.mockClear();
  toast.error.mockClear();
  rewriteText.mockReset();
  localStorage.clear();
});
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

async function editor(props: Record<string, unknown> = {}) {
  const box = document.createElement("form");
  document.body.append(box);
  const ref = createRef<Editor | null>() as React.RefObject<Editor | null>;
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(h(RichEditor, { bare: true, profile: "changelog", name: "content", label: "What changed", initial: doc as never, editorRef: ref, askAi, ...props })));
  await vi.waitFor(() => expect(ref.current).toBeTruthy());
  const editor = ref.current!;
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name);
  const click = async (name: string) => {
    await vi.waitFor(() => expect(button(name)).toBeTruthy());
    await act(async () => button(name)!.click());
  };
  // The selection bar shows a moment after a selection (the bubble menu's own delay).
  const select = async (from: number, to: number) => {
    await act(async () => editor.chain().focus().setTextSelection({ from, to }).run());
    await vi.waitFor(() => expect(button("Bold")).toBeTruthy());
  };
  const saved = () => JSON.parse(box.querySelector<HTMLInputElement>('input[name="content"]')!.value || "null") as typeof doc;
  const shown = (state: string) => box.querySelector(`[data-ask-ai="${state}"]`)?.textContent ?? null;
  return { editor, button, click, select, saved, shown };
}

test("Ask AI is on selected text only where it's set up; out of credits it shows, off", async () => {
  let view = await editor({ askAi: null });
  await view.select(SECOND, SECOND + 26);
  expect(view.button("Ask AI")).toBeUndefined();
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();

  view = await editor({ askAi: { ...askAi, paused: true } });
  await view.select(SECOND, SECOND + 26);
  expect(view.button("Ask AI")!.getAttribute("aria-disabled")).toBe("true");
  // Nothing selected: no Ask AI.
  await act(async () => view.editor.commands.setTextSelection(SECOND));
  await vi.waitFor(() => expect(view.button("Ask AI")).toBeUndefined());
});

test("a preset on part of a line: the AI gets the selection and the whole text; its version shows under it, and Accept puts it in place as one edit", async () => {
  const view = await editor();
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  const settle = answer();
  await view.click("Shorter");

  expect(rewriteText).toHaveBeenCalledWith("acme", {
    kind: "changelog",
    entry: 7,
    text: { type: "doc", content: [paragraph("They run in the background")] },
    whole: doc,
    instruction: "Make it shorter, keeping every change it mentions.",
  });
  expect(view.shown("working")).toBe("They run in the background");
  await settle({ content: { type: "doc", content: [paragraph("They run quietly")] } });
  expect(view.shown("old")).toBe("They run in the background");
  expect(view.shown("new")).toContain("They run quietly");
  // Nothing changes until it's accepted.
  expect(view.saved()).toEqual(doc);

  await view.click("Accept");
  expect(view.saved()).toEqual({ type: "doc", content: [paragraph("Exports are quick."), paragraph("They run quietly and email you when done.")] });
  expect(view.shown("new")).toBeNull();
  await act(async () => view.editor.commands.undo());
  expect(view.saved()).toEqual(doc);
});

test("Discard leaves the text as it was; an answer that comes after Discard is ignored", async () => {
  const view = await editor();
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  const settle = answer();
  await view.click("Clearer");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [paragraph("Quietly")] } });
  // A second ask on the same text replaces the first: its late answer isn't shown.
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  await view.click("Friendlier");
  await vi.waitFor(() => expect(view.shown("new")).toContain("Quietly"));
  await settle({ content: { type: "doc", content: [paragraph("Too late")] } });
  expect(view.shown("new")).toContain("Quietly");

  await view.click("Discard");
  expect(view.shown("new")).toBeNull();
  expect(view.shown("old")).toBeNull();
  expect(view.saved()).toEqual(doc);
});

test("edits elsewhere move it along; an edit inside the selected text drops it, saying so", async () => {
  const view = await editor();
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  let settle = answer();
  await view.click("Shorter");
  // Typed in the first line while the AI works: the selected text is still the one edited.
  await act(async () => view.editor.chain().insertContentAt(1, "Big ").run());
  await settle({ content: { type: "doc", content: [paragraph("They run quietly")] } });
  await view.click("Accept");
  expect(view.saved()).toEqual({ type: "doc", content: [paragraph("Big Exports are quick."), paragraph("They run quietly and email you when done.")] });

  await view.select(SECOND + 4, SECOND + 20);
  await view.click("Ask AI");
  settle = answer();
  await view.click("Shorter");
  await act(async () => view.editor.chain().insertContentAt(SECOND + 8, "X").run());
  expect(toast).toHaveBeenCalledWith("The text changed, so the AI's edit was dropped. Select it again to ask again.");
  expect(view.shown("working")).toBeNull();
  await settle({ content: { type: "doc", content: [paragraph("Never shown")] } });
  expect(view.shown("new")).toBeNull();
});

test("the team's own instruction is sent and kept for next time, the last 5, newest first; an error says why", async () => {
  const view = await editor();
  for (const instruction of ["One", "Two", "Three", "Four", "Five", "Six", "Two"]) {
    await view.select(SECOND, SECOND + 26);
    await view.click("Ask AI");
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[name="instruction"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, instruction);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    rewriteText.mockResolvedValueOnce({ error: "The AI couldn't edit the text. Try again in a moment." });
    await act(async () => input.form!.requestSubmit());
    expect(rewriteText).toHaveBeenLastCalledWith("acme", expect.objectContaining({ instruction }));
  }
  expect(toast.error).toHaveBeenCalledWith("The AI couldn't edit the text. Try again in a moment.");
  expect(view.shown("working")).toBeNull();

  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  const recent = document.querySelector('[role="group"][aria-label="Your recent instructions"]')!;
  expect([...recent.querySelectorAll("button")].map((each) => each.textContent)).toEqual(["Two", "Six", "Five", "Four", "Three"]);
});
