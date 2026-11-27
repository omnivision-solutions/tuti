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
  expect(toast).toHaveBeenCalledWith("The AI's earlier edit was dropped for this one.");
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

test("a list for part of a line goes in as its own block, as the preview shows it; the text around it stays", async () => {
  const view = await editor();
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  const settle = answer();
  await view.click("Make a list");
  // Answered once the dialog has closed (focus back in the text), as an AI's seconds later.
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await settle({
    content: { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [paragraph("Runs quietly")] }, { type: "listItem", content: [paragraph("Emails you")] }] }] },
  });
  expect(view.shown("new")).toContain("Runs quietly");
  // Its Accept has focus: a key in the text could no longer drop it.
  expect(document.activeElement?.textContent).toBe("Accept");

  await view.click("Accept");
  expect(view.saved()).toEqual({
    type: "doc",
    content: [
      paragraph("Exports are quick."),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Runs quietly")] }, { type: "listItem", content: [paragraph("Emails you")] }] },
      paragraph(" and email you when done."),
    ],
  });
});

test("Try again asks again for the same text and instruction; Escape on the AI's version discards it; an edit inside the text once it's shown drops it", async () => {
  const view = await editor();
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [paragraph("First try")] } });
  await view.click("Clearer");
  await vi.waitFor(() => expect(view.shown("new")).toContain("First try"));
  const second = answer();
  await view.click("Try again");
  // Back on the selected text while the AI works, then on the new version's Accept.
  expect(view.editor.view.hasFocus()).toBe(true);
  expect(view.editor.state.selection).toMatchObject({ from: SECOND, to: SECOND + 26 });
  await second({ content: { type: "doc", content: [paragraph("Second try")] } });
  expect(view.shown("new")).toContain("Second try");
  expect(document.activeElement?.textContent).toBe("Accept");
  expect(rewriteText).toHaveBeenCalledTimes(2);
  expect(rewriteText.mock.calls[1]).toEqual(rewriteText.mock.calls[0]);

  const version = document.querySelector<HTMLElement>('[data-ask-ai="new"]')!;
  await act(async () => version.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(view.shown("new")).toBeNull();
  expect(view.saved()).toEqual(doc);

  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [paragraph("Third try")] } });
  await view.click("Clearer");
  await vi.waitFor(() => expect(view.shown("new")).toContain("Third try"));
  await act(async () => view.editor.chain().insertContentAt(SECOND + 5, "X").run());
  expect(view.shown("new")).toBeNull();
  expect(toast).toHaveBeenCalledWith("The text changed, so the AI's edit was dropped. Select it again to ask again.");
});

test("part of a list item or of a heading stays part of it once accepted", async () => {
  const item = (text: string) => ({ type: "listItem", content: [paragraph(text)] });
  const listed = {
    type: "doc",
    content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Faster exprots today" }] }, { type: "bulletList", content: [item("Alpha beta gamma"), item("Delta")] }],
  };
  const view = await editor({ initial: listed });
  // "exprots" in the heading.
  await view.select(8, 15);
  await view.click("Ask AI");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "exports" }] }] } });
  await view.click("Fix grammar");
  await view.click("Accept");
  // "beta" in the first item.
  // After the heading (22), into the list, its item and its paragraph (3).
  const beta = 22 + 3 + "Alpha ".length;
  await view.select(beta, beta + 4);
  await view.click("Ask AI");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [paragraph("BETA")] } });
  await view.click("Clearer");
  // Sent as the line it's in, not the list around it.
  expect(rewriteText).toHaveBeenLastCalledWith("acme", expect.objectContaining({ text: { type: "doc", content: [paragraph("beta")] } }));
  await view.click("Accept");

  expect(view.saved()).toEqual({
    type: "doc",
    content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Faster exports today" }] }, { type: "bulletList", content: [item("Alpha BETA gamma"), item("Delta")] },
      // The empty line the editor keeps after a list that ends the text.
      { type: "paragraph" },
    ],
  });
});

test("the AI's version doesn't take focus from someone typing elsewhere", async () => {
  const view = await editor();
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  const settle = answer();
  await view.click("Shorter");
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  // Now typing in the first line.
  await act(async () => view.editor.chain().focus().setTextSelection(3).run());
  await settle({ content: { type: "doc", content: [paragraph("They run quietly")] } });
  expect(view.shown("new")).toContain("They run quietly");
  expect(view.editor.view.hasFocus()).toBe(true);
  expect(view.editor.state.selection.from).toBe(3);
});

test("a word in a nested list item goes as its own line, and comes back into it", async () => {
  const item = (text: string, ...more: object[]) => ({ type: "listItem", content: [paragraph(text), ...more] });
  const nested = { type: "doc", content: [{ type: "bulletList", content: [item("Outer", { type: "bulletList", content: [item("Inner words here")] })] }] };
  const view = await editor({ initial: nested });
  // "words": into the list, item, paragraph "Outer" (7), the nested list, its item and paragraph (3), past "Inner ".
  const words = 1 + 1 + 7 + 3 + "Inner ".length;
  await view.select(words, words + 5);
  await view.click("Ask AI");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [paragraph("WORDS")] } });
  await view.click("Shorter");
  expect(rewriteText).toHaveBeenLastCalledWith("acme", expect.objectContaining({ text: { type: "doc", content: [paragraph("words")] } }));
  await view.click("Accept");
  expect(view.saved().content[0]).toEqual({ type: "bulletList", content: [item("Outer", { type: "bulletList", content: [item("Inner WORDS here")] })] });
});

test("bold added inside the selected text while the AI works drops it; undo after Accept keeps typing done just before it", async () => {
  const view = await editor();
  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  let settle = answer();
  await view.click("Shorter");
  await act(async () => view.editor.chain().setTextSelection({ from: SECOND + 5, to: SECOND + 8 }).toggleBold().run());
  expect(toast).toHaveBeenCalledWith("The text changed, so the AI's edit was dropped. Select it again to ask again.");
  await settle({ content: { type: "doc", content: [paragraph("Never shown")] } });
  expect(view.shown("new")).toBeNull();
  await act(async () => view.editor.commands.undo());

  await view.select(SECOND, SECOND + 26);
  await view.click("Ask AI");
  settle = answer();
  await view.click("Shorter");
  await settle({ content: { type: "doc", content: [paragraph("They run quietly")] } });
  // Typed in the first line, then accepted at once.
  await act(async () => view.editor.chain().insertContentAt(1, "Big ").run());
  await view.click("Accept");
  await act(async () => view.editor.commands.undo());
  expect(view.saved()).toEqual({ type: "doc", content: [paragraph("Big Exports are quick."), doc.content[1]] });
});

test("a selection running to the very start of the next line, or from the very end of the one before, takes only its text", async () => {
  const view = await editor();
  // From the start of the first line to the start of the second (Shift+Down).
  await view.select(1, SECOND);
  await view.click("Ask AI");
  const settle = answer();
  await view.click("Shorter");
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await settle({ content: { type: "doc", content: [paragraph("Quick.")] } });
  expect(document.activeElement?.textContent).toBe("Accept");
  expect(rewriteText).toHaveBeenLastCalledWith("acme", expect.objectContaining({ text: { type: "doc", content: [paragraph("Exports are quick.")] } }));
  await view.click("Accept");
  expect(view.saved()).toEqual({ type: "doc", content: [paragraph("Quick."), doc.content[1]] });

  // From the end of the first line ("Quick.") into the second.
  const end = 1 + "Quick.".length;
  await view.select(end, end + 2 + 4);
  await view.click("Ask AI");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [paragraph("Those")] } });
  await view.click("Clearer");
  expect(rewriteText).toHaveBeenLastCalledWith("acme", expect.objectContaining({ text: { type: "doc", content: [paragraph("They")] } }));
  await view.click("Accept");
  expect(view.saved()).toEqual({ type: "doc", content: [paragraph("Quick."), paragraph("Those run in the background and email you when done.")] });
});

test("Select All edits the whole text: no extra context, and Accept replaces it", async () => {
  const view = await editor();
  await act(async () => view.editor.chain().focus().selectAll().run());
  await vi.waitFor(() => expect(view.button("Bold")).toBeTruthy());
  await view.click("Ask AI");
  const settle = answer();
  await view.click("Shorter");
  expect(rewriteText).toHaveBeenLastCalledWith("acme", expect.objectContaining({ text: doc, whole: undefined }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await settle({ content: { type: "doc", content: [paragraph("All of it, shorter.")] } });
  expect(view.shown("new")).toContain("All of it, shorter.");
  // On Accept, though Select All's own selection was wider than the text.
  expect(document.activeElement?.textContent).toBe("Accept");
  await view.click("Accept");
  expect(view.saved()).toEqual({ type: "doc", content: [paragraph("All of it, shorter.")] });
});

test("the version shows right after the list item it's for, and an editor that goes (a save remounting it) says the edit was dropped", async () => {
  const item = (text: string) => ({ type: "listItem", content: [paragraph(text)] });
  const listed = { type: "doc", content: [{ type: "bulletList", content: [item("One"), item("Two words"), item("Three")] }] };
  const view = await editor({ initial: listed });
  // "words" in the second item.
  const words = 1 + 1 + 5 + 2 + "Two ".length;
  await view.select(words, words + 5);
  await view.click("Ask AI");
  rewriteText.mockResolvedValueOnce({ content: { type: "doc", content: [paragraph("things")] } });
  await view.click("Clearer");
  await vi.waitFor(() => expect(view.shown("new")).toContain("things"));
  const items = [...document.querySelectorAll("li")];
  expect(items[1]!.querySelector('[data-ask-ai="new"]')).toBeTruthy();
  expect(items[2]!.querySelector('[data-ask-ai="new"]')).toBeNull();

  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  expect(toast).toHaveBeenCalledWith("The AI's edit was dropped.");
});
