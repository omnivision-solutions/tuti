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

test("after Replace image, Edit with AI on the new image has the tries it came from, the placed one picked", async () => {
  let made = 0;
  generateImage.mockImplementation(async () => ({ image: { id: `madeimage0000000000${++made}x`, url: `https://media.example/made${made}.png`, width: 1000, height: 500 } }));
  const { ref, pick, generate, button, click } = await editor();
  await pick();
  await generate();
  await click("Try again");
  await click("Try 1");
  await click("Replace image");
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(ref.current!.state.doc.child(1).attrs.mediaId).toBe("madeimage00000000001x");
  await pick();
  await click("Edit with AI");
  expect(button("Try 1")).toBeTruthy();
  expect(button("Try 2")).toBeTruthy();
  expect(button("Try 1")!.getAttribute("aria-pressed")).toBe("true");
  expect(document.body.textContent).toContain("Edited · 1 of 2");
});

test("Replace image again after an undo keeps tries the replaced image got meanwhile", async () => {
  let made = 0;
  generateImage.mockImplementation(async () => ({ image: { id: `madeimage0000000000${++made}x`, url: `https://media.example/made${made}.png`, width: 1000, height: 500 } }));
  const { ref, pick, generate, button, click } = await editor();
  const closed = () => vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await pick();
  await generate();
  await click("Try again");
  await click("Try 1");
  await click("Replace image");
  await closed();
  // On the image it became, a third try; then back to the original.
  await pick();
  await click("Edit with AI");
  const prompt = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Orange sky");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Try again");
  await vi.waitFor(() => expect(button("Try 3")).toBeTruthy());
  // Beside the original, the edited one takes only its own shape (no minimum height), so the two line up.
  const edited = document.querySelector<HTMLImageElement>('[role="dialog"] img[alt="Try 3"]')!.parentElement!;
  expect(edited.className).not.toContain("min-h-48");
  expect(edited.style.aspectRatio).toBe("1000 / 500");
  await act(async () => document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await closed();
  await act(async () => ref.current!.commands.undo());
  expect(ref.current!.state.doc.child(1).attrs.mediaId).toBe(ORIGINAL);
  // Replaced with Try 1 again: the image it becomes still has Try 3.
  await pick();
  await click("Edit with AI");
  await click("Try 1");
  await click("Replace image");
  await closed();
  await pick();
  await click("Edit with AI");
  await vi.waitFor(() => expect(button("Try 3")).toBeTruthy());
});

test("a try still being made when the dialog closes lands with its image's tries, after another image was edited too", async () => {
  const OTHER = "otherimage0000000000c";
  const two = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "image", attrs: { mediaId: ORIGINAL, w: 1000, h: 500 } },
      { type: "image", attrs: { mediaId: OTHER, w: 1000, h: 500 } },
    ],
  };
  let finish!: (value: unknown) => void;
  generateImage.mockReset();
  generateImage
    .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    .mockResolvedValue({ image: { id: "madeimage00000000002x", url: "https://media.example/made2.png", width: 1000, height: 500 } });
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
  await close();
  // Back on the first image while its try is still being made: it says so.
  await act(async () => ref.current!.commands.setNodeSelection(8));
  await click("Edit with AI");
  expect(button("Generating…")).toBeTruthy();
  await act(async () => finish({ image: { id: "madeimage00000000001x", url: "https://media.example/made1.png", width: 1000, height: 500 } }));
  expect(button("Try 1")).toBeTruthy();
  // A dialog made again starts with an empty prompt.
  const prompt = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Bluer");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Try again");
  expect(button("Try 1")).toBeTruthy();
  expect(button("Try 2")).toBeTruthy();
  expect(document.body.textContent).toContain("Edited · 2 of 2");
});

test("a try failing after its dialog was made again (another image edited meanwhile) says why", async () => {
  const OTHER = "otherimage0000000000c";
  const two = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "image", attrs: { mediaId: ORIGINAL, w: 1000, h: 500 } },
      { type: "image", attrs: { mediaId: OTHER, w: 1000, h: 500 } },
    ],
  };
  let finish!: (value: unknown) => void;
  generateImage.mockReset();
  generateImage.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
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
  await close();
  await act(async () => ref.current!.commands.setNodeSelection(8));
  await click("Edit with AI");
  await act(async () => finish({ error: "This project is out of credits" }));
  expect(button("Generating…")).toBeUndefined();
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("This project is out of credits");
  // Not the other image's: its dialog has no error.
  await close();
  await act(async () => ref.current!.commands.setNodeSelection(9));
  await click("Edit with AI");
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
});
