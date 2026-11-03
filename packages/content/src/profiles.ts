// The editor parts (parseHTML) read DOM elements; servers importing this need the DOM types too.
/// <reference lib="dom" />

import { type Extensions, getSchema, Node } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

import { isSafeLink, isVideo, LINK_REL, VIDEO_SANDBOX, videoEmbedUrl } from "./links";
import { fileExtension, fileSize, imageKey, imageWidths } from "./media";

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
    file: { setFile: (file: { mediaId: string; name: string; size: number }) => ReturnType };
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

/** Longest file name kept for an attachment (the server shortens longer ones as they're uploaded). */
export const MAX_FILE_NAME_LENGTH = 200;

/**
 * A file attachment (articles): an uploaded document, shown with its name, type and size, and
 * downloaded from a signed link (never opened on the storage's host). `name` and `size` come from
 * the upload; the server sets them as content is saved.
 */
export const FileNode = Node.create({
  name: "file",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { mediaId: { default: null }, name: { default: "" }, size: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-file]",
        getAttrs: (element) => ({
          mediaId: element.getAttribute("data-media-id"),
          name: element.getAttribute("data-name") ?? "",
          size: Number(element.getAttribute("data-size")) || null,
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const { mediaId, name, size } = node.attrs as Record<string, unknown>;
    const fileName = String(name ?? "");
    return [
      "div",
      { "data-file": "", "data-media-id": String(mediaId), "data-name": fileName, "data-size": String(size ?? ""), class: "rich-file" },
      ["span", { class: "rich-file-type", "aria-hidden": "true" }, fileExtension(fileName).toUpperCase() || "FILE"],
      ["span", { class: "rich-file-name" }, fileName],
      ["span", { class: "rich-file-size" }, isPixelSize(size) ? fileSize(size) : ""],
    ];
  },
  addCommands() {
    return {
      setFile:
        (file) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: file }),
    };
  },
});

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
        ...(profile === "article" ? [FileNode] : []),
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
