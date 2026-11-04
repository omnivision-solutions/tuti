// The editor parts (parseHTML) read DOM elements; servers importing this need the DOM types too.
/// <reference lib="dom" />

import { type Editor, Extension, type Extensions, getSchema, Node } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { type EditorState, Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

import { Details, DetailsContent, DetailsSummary } from "./details";
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
    steps: { setSteps: () => ReturnType };
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
  typeof value === "string" && value !== "" && value.length <= MAX_FILENAME_LENGTH && value.trim() === value && !/[\p{Cc}\u2028\u2029]/u.test(value);

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
            // Pasted labels as save has them: trimmed, and none unless valid.
            parseHTML: (element) => {
              const name = element.getAttribute("data-filename")?.trim();
              return isCodeFilename(name) ? name : null;
            },
            renderHTML: (attrs) => (attrs.filename ? { "data-filename": String(attrs.filename) } : {}),
          },
        },
      },
    ];
  },
});

/** A new tab's label: "Tab <n>", the first n from after the last tab that no tab in the group has. */
export function newTabLabel(labels: unknown[]): string {
  let n = labels.length + 1;
  while (labels.includes(`Tab ${n}`)) {
    n++;
  }
  return `Tab ${n}`;
}

/** Marks an edit of code tabs themselves (adding, removing or renaming one), which CodeTabs' guard lets through. */
export const CODE_TABS_EDIT = "codeTabsEdit";

/**
 * Code tabs (articles): two or more code blocks shown one at a time (e.g. npm, pnpm and yarn), each tab labelled by
 * its block's file name. The editor shows them one under the other. A third Enter at the end of any tab, or ArrowDown
 * at the end of the last, leaves the group (a code block's own would add a tab without a label). Backspace at the
 * start of a tab and Delete at the end of one before another do nothing (they'd turn the tab into a paragraph, which
 * the group can't hold, or join two tabs into one): "Remove tab" removes one. Shift-Enter and Mod-Enter are a new
 * line (a code block's own would add a tab), and an edit of the text that would change the tabs (a selection across
 * two deleted or typed over) is refused.
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
    const newLine = (editor: Editor) => {
      const { $from } = editor.state.selection;
      return $from.depth >= 2 && $from.node(-1).type.name === this.name && editor.commands.newlineInCode();
    };
    return {
      ArrowDown: ({ editor }) => leave(editor, 0),
      Enter: ({ editor }) => leave(editor, 2),
      "Shift-Enter": ({ editor }) => newLine(editor),
      "Mod-Enter": ({ editor }) => newLine(editor),
      Backspace: ({ editor }) => inTab(editor)?.parentOffset === 0,
      Delete: ({ editor }) => {
        const $from = atEnd(editor);
        return !!$from && $from.index(-1) < $from.node(-1).childCount - 1;
      },
    };
  },
  addProseMirrorPlugins() {
    return [codeTabsGuard()];
  },
});

/**
 * Refuses an edit of the text that changes code tabs (a selection across two deleted or typed over): a group still
 * there after the edit keeps its tabs and their labels, and no tab without a label appears (a selection from above a
 * group into one of its tabs has ProseMirror fill one in), unless the edit is of the tabs (CODE_TABS_EDIT) or an undo
 * or redo.
 */
export function codeTabsGuard(): Plugin {
  const labels = (group: PMNode) => JSON.stringify(group.content.content.map((tab) => tab.attrs.filename as unknown));
  const unlabelled = (doc: PMNode) => {
    let count = 0;
    doc.descendants((node, _pos, parent) => {
      count += parent?.type.name === "codeTabs" && !node.attrs.filename ? 1 : 0;
      return !node.isTextblock;
    });
    return count;
  };
  return new Plugin({
    filterTransaction: (tr, state) => {
      if (!tr.docChanged || tr.getMeta(CODE_TABS_EDIT) || tr.getMeta("history$")) {
        return true;
      }
      let ok = true;
      state.doc.descendants((node, pos) => {
        if (node.type.name === "codeTabs") {
          const start = tr.mapping.mapResult(pos, 1);
          const after = start.deleted ? null : tr.doc.nodeAt(start.pos);
          ok &&= after?.type.name !== "codeTabs" || labels(after) === labels(node);
        }
        return ok && node.type.name !== "codeTabs";
      });
      // The old document is walked only when the new one has a tab without a label (rarely): typing stays cheap.
      const after = ok ? unlabelled(tr.doc) : 0;
      return ok && (after === 0 || after <= unlabelled(state.doc));
    },
  });
}

/**
 * Numbered steps (articles): a how-to, each step a short title and then its own paragraphs, lists, code and
 * images, shown with a large number and a line joining them. No headings inside, so "On this page" and an
 * article's sections stay top-level. In the editor, Enter on an empty line ending a step starts the next one,
 * Enter on a new step's empty title leaves the steps, and Backspace at a title's start joins the step to the
 * one before (or, the first, takes it out of the block).
 */
export const Steps = Node.create({
  name: "steps",
  group: "block",
  content: "step+",
  // Ahead of the core keymap (its Enter and Backspace) and of ordered lists when reading HTML.
  priority: 101,
  parseHTML() {
    return [{ tag: "ol[data-steps]" }];
  },
  renderHTML() {
    return ["ol", { "data-steps": "", class: "rich-steps" }, 0];
  },
  addCommands() {
    return {
      setSteps:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({ type: "steps", content: [{ type: "step", content: [{ type: "stepTitle" }] }] })
            // Into the step's title (Enter at its end starts the step's body).
            .command(({ tr }) => {
              const { $from } = tr.selection;
              tr.setSelection(TextSelection.create(tr.doc, $from.start($from.depth - 1) + 1));
              return true;
            })
            .run(),
    };
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => nextStep(editor.state, editor.view.dispatch),
      Backspace: ({ editor }) => joinStep(editor.state, editor.view.dispatch),
    };
  },
});

export const Step = Node.create({
  name: "step",
  content: "stepTitle (paragraph | bulletList | orderedList | codeBlock | codeTabs | image)*",
  defining: true,
  priority: 101,
  parseHTML() {
    return [{ tag: "li[data-step]" }];
  },
  renderHTML() {
    return ["li", { "data-step": "" }, 0];
  },
});

export const StepTitle = Node.create({
  name: "stepTitle",
  content: "inline*",
  defining: true,
  priority: 101,
  parseHTML() {
    return [{ tag: "p[data-step-title]" }];
  },
  renderHTML() {
    return ["p", { "data-step-title": "", class: "rich-step-title" }, 0];
  },
});

type Dispatch = ((tr: EditorState["tr"]) => void) | undefined;

/** Enter on the empty last line of a step: the next step. On a new last step's empty title: out of the steps, onto a new line. */
export function nextStep(state: EditorState, dispatch: Dispatch): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 3 || $from.node(-1).type.name !== "step" || $from.parent.content.size > 0) {
    return false;
  }
  const step = $from.node(-1);
  const tr = state.tr;
  if ($from.parent.type.name === "paragraph" && $from.index(-1) === step.childCount - 1) {
    tr.delete($from.before(), $from.after());
    const at = tr.mapping.map($from.after(-1));
    tr.insert(at, state.schema.nodes.step!.createAndFill()!);
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
  } else if ($from.parent.type.name === "stepTitle" && step.childCount === 1 && $from.index(-2) > 0 && $from.index(-2) === $from.node(-2).childCount - 1) {
    tr.delete($from.before(-1), $from.after(-1));
    const at = tr.mapping.map($from.after(-2));
    tr.insert(at, state.schema.nodes.paragraph!.create());
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
  } else {
    return false;
  }
  dispatch?.(tr.scrollIntoView());
  return true;
}

/**
 * Backspace at the start of a step's title: the step (its title as a paragraph) joins the end of the step before;
 * the first step moves out above the block (the block goes once it has none). An empty step is just taken out.
 */
export function joinStep(state: EditorState, dispatch: Dispatch): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "stepTitle" || $from.parentOffset > 0) {
    return false;
  }
  const step = $from.node(-1);
  const paragraph = state.schema.nodes.paragraph!;
  const blank = step.children.every((child) => child.isTextblock && child.content.size === 0);
  const content: PMNode[] = blank ? [] : [paragraph.create(null, step.firstChild!.content), ...step.children.slice(1)];
  const [stepStart, stepEnd] = [$from.before(-1), $from.after(-1)];
  const tr = state.tr;
  if ($from.index(-2) > 0) {
    tr.delete(stepStart, stepEnd).insert(stepStart - 1, content);
    tr.setSelection(blank ? Selection.near(tr.doc.resolve(stepStart - 1), -1) : TextSelection.create(tr.doc, stepStart));
  } else {
    const [blockStart, blockEnd] = [$from.before(-2), $from.after(-2)];
    const out = content.length > 0 ? content : [paragraph.create()];
    if ($from.node(-2).childCount === 1) {
      tr.replaceWith(blockStart, blockEnd, out);
    } else {
      tr.delete(stepStart, stepEnd).insert(blockStart, out);
    }
    tr.setSelection(TextSelection.create(tr.doc, blockStart + 1));
  }
  dispatch?.(tr.scrollIntoView());
  return true;
}

/**
 * A table of contents (articles): the article's headings as links, made from them as it's shown (RichText,
 * toMarkdown, the editor's view), never stored. Top-level only, where the headings are: its own group, which only
 * the article's document takes, so nothing (a paste, a drag) can put it in a list, quote or table.
 */
export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "topBlock",
  atom: true,
  draggable: true,
  parseHTML() {
    return [{ tag: "nav[data-toc]" }];
  },
  renderHTML() {
    return ["nav", { "data-toc": "" }];
  },
});

/** An article's document: blocks, and the table of contents at the top level. */
const ArticleDocument = Node.create({ name: "doc", topNode: true, content: "(block | topBlock)+" });

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
        StarterKit.configure({ ...textOnly, heading: { levels: [2, 3] }, blockquote: {}, horizontalRule: {}, ...(profile === "article" && { document: false }) }),
        VideoEmbed,
        ImageNode.configure({ mediaUrl }),
        // Plain tables: no column resizing (widths aren't stored or rendered).
        ...(profile === "article" ? [ArticleDocument, TableKit.configure({ table: { resizable: false } }), TableOfContents] : []),
        // Collapsible details (details.ts).
        ...(profile === "article" ? [Details, DetailsSummary, DetailsContent] : []),
        // Numbered steps (Steps, Step, StepTitle above).
        ...(profile === "article" ? [Steps, Step, StepTitle] : []),
        // Code with a file name, and code tabs.
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
