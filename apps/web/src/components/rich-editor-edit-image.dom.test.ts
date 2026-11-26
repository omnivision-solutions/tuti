// @vitest-environment happy-dom
import type { Editor } from "@tiptap/react";
import { act, createElement as h, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const generateImage = vi.fn();
vi.mock("@/server/images", () => ({ generateImage }));
vi.mock("@/server/media", () => ({
  uploadStatus: async (id: string) => ({ status: "READY", src: `https://media.example/${id}-full.png`, download: "x", urls: { [`m/${id}/960.webp`]: `https://media.example/${id}-960.webp` }, width: 1000, height: 500 }),
}));
const toast = vi.fn();
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/upload-image", () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }));

const { RichEditor } = await import("./rich-editor");

const ORIGINAL = "origimage00000000000a";
const MADE = "madeimage00000000000b";
beforeEach(() => {
  generateImage.mockReset();
  generateImage.mockResolvedValue({ image: { id: MADE, url: `https://media.example/${MADE}.png`, width: 1000, height: 500 } });
});
// Unmounted before the page is cleared: a dialog's portal left to an old root fails its next update.
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

const doc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Before" }] },
    { type: "image", attrs: { mediaId: ORIGINAL, width: "50", align: "left", alt: "The settings page", w: 1000, h: 500 } },
    { type: "paragraph", content: [{ type: "text", text: "After" }] },
  ],
};
const imageEditing = { credits: false, paused: false, logo: null, title: "Dark mode" };

async function editor(props: Record<string, unknown> = {}) {
  const box = document.createElement("form");
  document.body.append(box);
  const ref = createRef<Editor | null>() as React.RefObject<Editor | null>;
  const root = createRoot(box);
  roots.push(root);
  await act(async () =>
    root.render(
      h(RichEditor, {
        profile: "changelog",
        name: "content",
        label: "What changed",
        initial: doc as never,
        uploads: { projectSlug: "acme", mediaUrls: { [`m/${ORIGINAL}/960.webp`]: `https://media.example/${ORIGINAL}-960.webp` } },
        editorRef: ref,
        imageEditing,
        ...props,
      }),
    ),
  );
  await vi.waitFor(() => expect(ref.current).toBeTruthy());
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name);
  const click = (name: string) => act(async () => button(name)!.click());
  // The image picked, as a click on it picks it.
  const pick = () => act(async () => ref.current!.commands.setNodeSelection(8));
  const images = () => (JSON.parse(box.querySelector<HTMLInputElement>('input[name="content"]')!.value || "null")?.content ?? []).filter((node: { type: string }) => node.type === "image").map((node: { attrs: unknown }) => node.attrs);
  const generate = async () => {
    await click("Edit with AI");
    const prompt = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Orange sky");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Generate");
  };
  return { ref, button, click, pick, images, generate };
}

test("Edit with AI is on a picked image only where the server makes images; out of credits it shows, off", async () => {
  let shown = await editor({ imageEditing: null });
  await shown.pick();
  expect(shown.button("Alt text")).toBeTruthy();
  expect(shown.button("Edit with AI")).toBeUndefined();
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  shown = await editor({ imageEditing: { ...imageEditing, paused: true } });
  await shown.pick();
  expect(shown.button("Edit with AI")!.getAttribute("aria-disabled")).toBe("true");
  // Its reason is its description, for keyboard, touch and screen reader users too (not a hover-only title).
  const off = shown.button("Edit with AI")!;
  expect(document.getElementById(off.getAttribute("aria-describedby")!)?.textContent).toBe("This project is out of credits");
});

test("Edit with AI isn't offered on an image that isn't one of the project's uploads shown here", async () => {
  const { pick, button } = await editor({ uploads: { projectSlug: "acme", mediaUrls: {} } });
  await pick();
  expect(button("Alt text")).toBeTruthy();
  expect(button("Edit with AI")).toBeUndefined();
});

test("the dialog edits the picked image: in the entry, it first among references, its size the default", async () => {
  const { pick, generate } = await editor();
  await pick();
  await generate();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Edit image");
  expect(dialog.textContent).toContain("In “Dark mode”");
  expect(generateImage).toHaveBeenCalledWith("acme", { prompt: "Orange sky", width: 1000, height: 500, references: [ORIGINAL] });
});

test("Replace image swaps the image where it is, keeping its alt text, size and alignment; undo brings the original back", async () => {
  const { ref, pick, generate, click, images } = await editor();
  await pick();
  await generate();
  await click("Replace image");
  await vi.waitFor(() => expect(images()).toEqual([{ mediaId: MADE, width: "50", align: "left", alt: "The settings page", w: 1000, h: 500 }]));
  expect(ref.current!.state.doc.child(1).attrs.mediaId).toBe(MADE);
  expect(document.querySelector<HTMLImageElement>(".ProseMirror img")!.src).toBe(`https://media.example/${MADE}-960.webp`);
  await act(async () => ref.current!.commands.undo());
  expect(images()).toEqual([{ mediaId: ORIGINAL, width: "50", align: "left", alt: "The settings page", w: 1000, h: 500 }]);
});

test("Insert as new adds the image right after the original, which stays", async () => {
  const { ref, pick, generate, click, images } = await editor();
  await pick();
  await generate();
  await click("Insert as new");
  await vi.waitFor(() => expect(images().map((each: { mediaId: string }) => each.mediaId)).toEqual([ORIGINAL, MADE]));
  expect(ref.current!.state.doc.child(2).attrs).toMatchObject({ mediaId: MADE, width: "50", align: "left", alt: "" });
  expect(ref.current!.state.doc.child(3).textContent).toBe("After");
});

test("an image too thin or too small for AI starts at its shape scaled into range (64 to 2,400 pixels a side)", async () => {
  const { generatable } = await import("./rich-editor");
  expect(generatable({ width: 1000, height: 500 })).toEqual({ width: 1000, height: 500 });
  expect(generatable({ width: 1200, height: 40 })).toEqual({ width: 1920, height: 64 });
  expect(generatable({ width: 32, height: 32 })).toEqual({ width: 64, height: 64 });
  expect(generatable({ width: 2400, height: 10 })).toEqual({ width: 2400, height: 64 });
});

test("the dialog keeps its tries for the image while the text before it changes", async () => {
  const { ref, pick, generate, button, click } = await editor();
  await pick();
  await generate();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await act(async () => ref.current!.chain().insertContentAt(1, "Just ").run());
  await act(async () => ref.current!.commands.setNodeSelection(13));
  await click("Edit with AI");
  expect(button("Try 1")).toBeTruthy();
  expect(document.body.textContent).toContain("Edited · 1 of 1");
});

test("out of credits, Edit with AI says why when pressed (a tap: no tooltip on touch screens), and its tooltip has its name and why", async () => {
  toast.mockReset();
  const { pick, button } = await editor({ imageEditing: { ...imageEditing, paused: true } });
  await pick();
  const off = button("Edit with AI")!;
  await act(async () => off.click());
  expect(toast).toHaveBeenCalledWith("This project is out of credits");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => {
    off.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
    off.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    off.focus();
  });
  await vi.waitFor(() => expect(document.body.textContent).toContain("Edit with AI · This project is out of credits"), { timeout: 3000 });
});

test("each image keeps its tries while the editor is open: back from another image, they're there", async () => {
  const OTHER = "otherimage0000000000c";
  const two = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "image", attrs: { mediaId: ORIGINAL, w: 1000, h: 500 } },
      { type: "image", attrs: { mediaId: OTHER, w: 1000, h: 500 } },
    ],
  };
  const { ref, generate, button, click } = await editor({
    initial: two,
    uploads: { projectSlug: "acme", mediaUrls: { [`m/${ORIGINAL}/960.webp`]: "https://media.example/a.webp", [`m/${OTHER}/960.webp`]: "https://media.example/b.webp" } },
  });
  const close = async () => {
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  };
  await act(async () => ref.current!.commands.setNodeSelection(8));
  await generate();
  await close();
  await act(async () => ref.current!.commands.setNodeSelection(9));
  await click("Edit with AI");
  expect(button("Try 1")).toBeUndefined();
  await close();
  await act(async () => ref.current!.commands.setNodeSelection(8));
  await click("Edit with AI");
  expect(button("Try 1")).toBeTruthy();
  expect(document.body.textContent).toContain("Edited · 1 of 1");
});
