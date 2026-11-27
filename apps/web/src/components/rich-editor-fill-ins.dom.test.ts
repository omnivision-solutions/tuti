// @vitest-environment happy-dom
import type { Editor } from "@tiptap/react";
import { act, createElement as h, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Profile } from "@tuti/content";

vi.mock("@/server/rewrite", () => ({ rewriteText: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@/lib/upload-image", () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }));
vi.mock("@/server/images", () => ({ generateImage: vi.fn() }));
vi.mock("@/server/media", () => ({ uploadStatus: vi.fn() }));

const { RichEditor } = await import("./rich-editor");

const text = (value: string) => ({ type: "text", text: value });
const doc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [text("Help opens beside the app.")] },
    { type: "paragraph", content: [text("[Screenshot: the help panel]")] },
    // One inside a sentence, its own brackets inside it, and a line break after it.
    { type: "paragraph", content: [text("Out on web [Check: and on [iOS]?] now"), { type: "hardBreak" }, text("[ check : left open")] },
  ],
};

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

async function editor(profile: Profile) {
  const box = document.createElement("form");
  document.body.append(box);
  const ref = createRef<Editor | null>() as React.RefObject<Editor | null>;
  const root = createRoot(box);
  roots.push(root);
  await act(async () => root.render(h(RichEditor, { bare: true, profile, name: "content", label: "Text", initial: doc as never, editorRef: ref })));
  await vi.waitFor(() => expect(ref.current).toBeTruthy());
  return ref.current!;
}
const highlighted = () => [...document.querySelectorAll("[data-fill-in]")].map((each) => each.textContent);

test("lines a draft left to fill in are highlighted in a changelog entry and an article, as publishing finds them; as typed too", async () => {
  for (const profile of ["changelog", "article"] as const) {
    const open = await editor(profile);
    expect(highlighted()).toEqual(["[Screenshot: the help panel]", "[Check: and on [iOS]?]", "[ check : left open"]);
    expect(document.querySelector("[data-fill-in]")!.className).toContain("bg-highlight");
    await act(async () => open.chain().insertContentAt(1 + "Help opens beside the app.".length, " [Check: a date?]").run());
    expect(highlighted()).toContain("[Check: a date?]");
    // Replaced, it's no longer highlighted.
    await act(async () => open.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [text("Out on web and iOS.")] }] }));
    expect(highlighted()).toEqual([]);
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    document.body.replaceChildren();
  }
});

test("a comment or post isn't a draft: nothing highlighted", async () => {
  await editor("comment");
  expect(highlighted()).toEqual([]);
});
