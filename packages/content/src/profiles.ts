// The editor parts (parseHTML) read DOM elements; servers importing this need the DOM types too.
/// <reference lib="dom" />

import { type Editor, Extension, type Extensions, getSchema, Node } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

import { isSafeLink, isVideo, LINK_REL, VIDEO_SANDBOX, videoEmbedUrl } from "./links";
import { imageKey, imageWidths } from "./media";

/**
 * What each kind of content may contain. The editor, the server-side validation
 * and the renderers all derive from these, so they agree on every node and mark.
 * `changelog` adds headings, quotes and dividers to `post`; `article` (docs)
 * adds tables to `changelog`.
 */
export const PROFILES = ["comment", "post", "changelog", "article"] as const;
export type Profile = (typeof PROFILES)[number];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    video: { setVideo: (video: { provider: string; id: string }) => ReturnType };
    image: { setImage: (image: { mediaId: string; w: number; h: number }) => ReturnType };
  }
}

/** How wide an image is shown, as a share of the text column. */
export const IMAGE_SIZES = ["25", "50", "75", "100"] as const;
export const IMAGE_ALIGNMENTS = ["left", "center", "right"] as const;
export const MAX_ALT_LENGTH = 300;

/** A table cell's colspan or rowspan. */
export const isCellSpan = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 20;

/** Uploaded media ids (cuid). */
export const isMediaId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{20,32}$/.test(value);

/** An image's stored width or height: a whole number of pixels, above zero. */
export const isPixelSize = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/**
 * An uploaded image (see media.ts), shown at a share of the column's width and
 * aligned left, center or right. `w` and `h` are its size in pixels, so pages
 * reserve its space before it loads; the server sets them from the upload.
 */
export const ImageNode = Node.create<{ mediaUrl?: (key: string) => string | undefined }>({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addOptions() {
    return { mediaUrl: undefined };
  },
  addAttributes() {
    return {
      mediaId: { default: null },
      width: { default: "100" },
      align: { default: "center" },
      alt: { default: "" },
      w: { default: null },
      h: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "figure[data-image]",
        getAttrs: (element) => ({
          mediaId: element.getAttribute("data-media-id"),
          width: element.getAttribute("data-width") ?? "100",
          align: element.getAttribute("data-align") ?? "center",
          alt: element.querySelector("img")?.getAttribute("alt") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const { mediaId, width, align, alt, w, h } = node.attrs as Record<string, unknown>;
    const src = (isMediaId(mediaId) && isPixelSize(w) && this.options.mediaUrl?.(imageKey(mediaId, editorWidth(w)))) || "";
    return [
      "figure",
      { "data-image": "", "data-media-id": String(mediaId), "data-width": String(width), "data-align": String(align), class: "rich-image" },
      ["img", { src, alt: String(alt ?? ""), width: String(w ?? ""), height: String(h ?? "") }],
    ];
  },
  addCommands() {
    return {
      setImage:
        (image) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: image }),
    };
  },
});

/** The stored size the editor shows: big enough for the column, no bigger. */
const editorWidth = (w: number) => imageWidths(w).find((width) => width >= 960) ?? w;

/** A video from an allowed provider, stored as provider + id and embedded from a known URL. */
export const VideoEmbed = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { provider: { default: null }, id: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-video]",
        getAttrs: (element) => ({ provider: element.getAttribute("data-provider"), id: element.getAttribute("data-id") }),
      },
    ];
  },
  renderHTML({ node }) {
    const video = { provider: node.attrs.provider as unknown, id: node.attrs.id as unknown };
    return [
      "div",
      { "data-video": "", "data-provider": String(video.provider), "data-id": String(video.id), class: "rich-video" },
      [
        "iframe",
        {
          src: isVideo(video) ? videoEmbedUrl(video) : "about:blank",
          sandbox: VIDEO_SANDBOX,
          allowfullscreen: "true",
          loading: "lazy",
          title: "Video",
        },
      ],
    ];
  },
  addCommands() {
    return {
      setVideo:
        (video) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: video }),
    };
  },
});

/** A code block's file name (articles), shown above its code; in code tabs, the tab's label. One short line. */
export const MAX_FILENAME_LENGTH = 80;
export const MAX_CODE_TABS = 8;
export const isCodeFilename = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= MAX_FILENAME_LENGTH && value.trim() === value && !/\p{Cc}/u.test(value);

/** Articles' code blocks may have a file name (posts' and changelog entries' don't: theirs has no such attribute). */
const CodeFilename = Extension.create({
  name: "codeFilename",
  addGlobalAttributes() {
    return [
      {
        types: ["codeBlock"],
        attributes: {
          filename: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-filename"),
            renderHTML: (attrs) => (attrs.filename ? { "data-filename": String(attrs.filename) } : {}),
          },
        },
      },
    ];
  },
});

/**
 * Code tabs (articles): two or more code blocks shown one at a time (e.g. npm, pnpm and yarn), each tab labelled by
 * its block's file name. The editor shows them one under the other. A third Enter at the end of any tab, or ArrowDown
 * at the end of the last, leaves the group (a code block's own would add a tab without a label). Backspace at the
 * start of a tab and Delete at the end of one before another do nothing (they'd turn the tab into a paragraph, which
 * the group can't hold, or join two tabs into one): "Remove tab" removes one.
 */
export const CodeTabs = Node.create({
  name: "codeTabs",
  group: "block",
  content: `codeBlock{2,${MAX_CODE_TABS}}`,
  isolating: true,
  // Before the code block's own keys.
  priority: 101,
  parseHTML() {
    return [{ tag: "div[data-code-tabs]" }];
  },
  renderHTML() {
    return ["div", { "data-code-tabs": "" }, 0];
  },
  addKeyboardShortcuts() {
    const inTab = (editor: Editor) => {
      const { $from, empty } = editor.state.selection;
      return empty && $from.depth >= 2 && $from.node(-1).type.name === this.name ? $from : null;
    };
    const atEnd = (editor: Editor) => {
      const $from = inTab(editor);
      return $from && $from.parentOffset === $from.parent.content.size ? $from : null;
    };
    const leave = (editor: Editor, trim: number) => {
      const $from = atEnd(editor);
      if (!$from || (trim ? !$from.parent.textContent.endsWith("\n\n") : $from.index(-1) < $from.node(-1).childCount - 1)) {
        return false;
      }
      return editor.commands.command(({ tr, state }) => {
        tr.delete($from.pos - trim, $from.pos);
        const after = tr.mapping.map($from.after(-1));
        if (!tr.doc.nodeAt(after)) {
          tr.insert(after, state.schema.nodes.paragraph!.create());
        }
        tr.setSelection(Selection.near(tr.doc.resolve(after)));
        return true;
      });
    };
    return {
      ArrowDown: ({ editor }) => leave(editor, 0),
      Enter: ({ editor }) => leave(editor, 2),
      Backspace: ({ editor }) => inTab(editor)?.parentOffset === 0,
      Delete: ({ editor }) => {
        const $from = atEnd(editor);
        return !!$from && $from.index(-1) < $from.node(-1).childCount - 1;
      },
    };
  },
});

const textOnly = {
  heading: false,
  blockquote: false,
  horizontalRule: false,
  strike: false,
  underline: false,
  link: {
    openOnClick: false,
    autolink: true,
    defaultProtocol: "https",
    isAllowedUri: (url: string) => isSafeLink(url),
    HTMLAttributes: { rel: LINK_REL, target: "_blank" },
  },
} as const;

/** `mediaUrl`: where the editor loads a stored image file from (signed URLs; see MediaUrls). */
export function extensions(profile: Profile, { mediaUrl }: { mediaUrl?: (key: string) => string | undefined } = {}): Extensions {
  switch (profile) {
    case "comment":
      return [
        StarterKit.configure({
          ...textOnly,
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          codeBlock: false,
        }),
      ];
    case "post":
      return [StarterKit.configure(textOnly), VideoEmbed, ImageNode.configure({ mediaUrl })];
    case "changelog":
    case "article":
      return [
        // Sections under the entry's own title: h2 and h3 only.
        StarterKit.configure({ ...textOnly, heading: { levels: [2, 3] }, blockquote: {}, horizontalRule: {} }),
        VideoEmbed,
        ImageNode.configure({ mediaUrl }),
        // Plain tables: no column resizing (widths aren't stored or rendered).
        ...(profile === "article" ? [TableKit.configure({ table: { resizable: false } })] : []),
        ...(profile === "article" ? [CodeFilename, CodeTabs] : []),
      ];
  }
}

const schemas = new Map<Profile, Schema>();

export function schemaFor(profile: Profile): Schema {
  let schema = schemas.get(profile);
  if (!schema) {
    schema = getSchema(extensions(profile));
    schemas.set(profile, schema);
  }
  return schema;
}
