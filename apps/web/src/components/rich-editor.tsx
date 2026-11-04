"use client";

import { Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  CODE_TABS_EDIT,
  newTabLabel,
  extensions,
  IMAGE_ALIGNMENTS,
  IMAGE_SIZES,
  isCodeFilename,
  isEmptyDoc,
  isSafeLink,
  MAX_ALT_LENGTH,
  MAX_CODE_TABS,
  MAX_FILENAME_LENGTH,
  parseVideoUrl,
  readableBy,
  readablePart,
  type Doc,
  type MediaUrls,
  type Profile,
  TableOfContents,
  UPLOAD_FILE_TYPES,
} from "@tuti/content";
import { cn } from "cn";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AppWindowIcon,
  BoldIcon,
  CodeIcon,
  FootprintsIcon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListCollapseIcon,
  ListIcon,
  ListOrderedIcon,
  type LucideIcon,
  MinusIcon,
  PaperclipIcon,
  QuoteIcon,
  SquareCodeIcon,
  TableIcon,
  TableOfContentsIcon,
  TextIcon,
  VideoIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EditorTableOfContents } from "@/components/rich-editor-toc";
import { uploadFile, uploadImage } from "@/lib/upload-image";

/** What the file picker offers for attachments (the server checks each file too). */
const FILE_ACCEPT = Object.keys(UPLOAD_FILE_TYPES)
  .map((extension) => `.${extension}`)
  .join(",");

type Prompt = "link" | "video" | "alt" | "filename";
const UPLOAD_FAILED = "The upload failed. Try again.";
/** A title written above a bare editor, as it's published: no box, set like a heading (add its size). */
export const BARE_TITLE =
  "w-full min-w-0 bg-transparent font-heading font-bold tracking-tight outline-none placeholder:text-muted-foreground/60";
/** Where images can be uploaded to; without it, the editor has no images. */
/** `mediaUrls`: signed URLs of the images in `initial` (server/media-urls.ts); new uploads add theirs. */
export type EditorUploads = { projectSlug: string; mediaUrls: MediaUrls };

/**
 * The rich text editor for one content profile (see @tuti/content). It submits the
 * document as JSON in a hidden input called `name` (empty when there's nothing in it);
 * the server validates it against the same profile. Remount it (change its `key`) to clear it.
 * `initial` is what it starts with (editing something saved). `bare` is the distraction-free
 * look of long writing: no box and no toolbar, the text set as it's published; blocks come from a
 * menu that typing / at the start of a line opens, and formatting from a bar over selected text.
 */
export function RichEditor({
  profile,
  name,
  placeholder,
  label,
  labelledBy,
  invalid,
  describedBy,
  uploads,
  initial,
  editorRef: outerRef,
  onChange,
  onCreate,
  onReadable,
  bare = false,
}: {
  profile: Profile;
  name: string;
  placeholder?: string;
  /** Accessible name, when there's no visible label (otherwise use labelledBy). */
  label?: string;
  labelledBy?: string;
  invalid?: boolean;
  /** Id of the element with the error text, while `invalid`. */
  describedBy?: string;
  uploads?: EditorUploads;
  initial?: Doc;
  /** Set to the editor once it's created, for tools outside it (e.g. the changelog's AI helpers). */
  editorRef?: React.RefObject<Editor | null>;
  /** Called on every change to the document. */
  onChange?: (editor: Editor) => void;
  /** Called once the editor is made (in the browser, after the page is ready). */
  onCreate?: (editor: Editor) => void;
  /**
   * Called as the editor is made: whether it can read its text. If not, it shows what it can, read-only, and its form
   * doesn't submit.
   */
  onReadable?: (readable: boolean) => void;
  bare?: boolean;
}) {
  const [value, setValue] = useState(initial && !isEmptyDoc(initial) ? JSON.stringify(initial) : "");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [uploading, setUploading] = useState(0);
  // The saved text has something this editor doesn't know (saved by a newer release, while a deploy runs both): shown
  // read-only, and its form doesn't submit, so a save from here can't replace text this page never had.
  const [unreadable, setUnreadable] = useState(false);
  // Read by the editor's handlers, which don't see the state above until it renders.
  const unreadableRef = useRef(false);
  const unreadableNote = useId();
  /** File attachments uploading (articles); `uploading` counts them too. */
  const [attaching, setAttaching] = useState(0);
  const [uploadError, setUploadError] = useState<string>();
  /** Someone tried to submit while images were uploading. */
  const [held, setHeld] = useState(false);
  const canUpload = profile !== "comment" && !!uploads;
  // Files are attached to articles only.
  const canAttach = profile === "article" && !!uploads;
  // The image node reads these as it draws, so uploads add their URLs here first.
  const [mediaUrls] = useState(() => new Map(Object.entries(uploads?.mediaUrls ?? {})));

  /** A new paste, drop or pick forgets the last one's error (once, so images' errors stay when files follow). */
  const startUploads = () => {
    setUploadError(undefined);
    setHeld(false);
  };
  // Nothing to add leaves the last error alone.
  const addImages = async (editor: Editor, files: File[]) => {
    if (!uploads || files.length === 0) {
      return;
    }
    for (const file of files) {
      setUploading((n) => n + 1);
      // A request that fails outright (offline) is an error too, so the count goes back down.
      const result = await uploadImage(uploads.projectSlug, file).catch(() => ({ error: UPLOAD_FAILED }));
      setUploading((n) => n - 1);
      if ("error" in result) {
        setUploadError(result.error);
      } else {
        Object.entries(result.urls).forEach(([key, url]) => mediaUrls.set(key, url));
        editor.chain().focus().setImage(result).run();
      }
    }
  };
  const addFiles = async (editor: Editor, files: File[]) => {
    if (!uploads || files.length === 0) {
      return;
    }
    for (const file of files) {
      setUploading((n) => n + 1);
      setAttaching((n) => n + 1);
      const result = await uploadFile(uploads.projectSlug, file).catch(() => ({ error: UPLOAD_FAILED }));
      setUploading((n) => n - 1);
      setAttaching((n) => n - 1);
      if ("error" in result) {
        setUploadError(result.error);
      } else {
        editor.chain().focus().setFile(result).run();
      }
    }
  };
  // Paste and drop handlers are set up with the editor, before `editor` below has a value.
  const editorRef = useRef<Editor | null>(null);
  // The editor reads its attributes on every update; the effect below keeps the error state current.
  const aria = useRef<Record<string, string>>({});

  // The / menu's keys (arrows, Enter, Escape) while it's open.
  const menuKeys = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  // The / menu and the selection bar go right after the text, so Tab from the text reaches the bar's buttons.
  const menus = useRef<HTMLDivElement>(null);
  const menusHost = useCallback(() => menus.current ?? document.body, []);

  const imagesFrom = (list: FileList | undefined | null) =>
    canUpload ? [...(list ?? [])].filter((file) => file.type.startsWith("image/")) : [];
  /** Pasted or dropped files that aren't images, attached where files can be. */
  const attachmentsFrom = (list: FileList | undefined | null) =>
    canAttach ? [...(list ?? [])].filter((file) => !file.type.startsWith("image/")) : [];
  /** Uploads what was pasted or dropped: images as images, other files as attachments. Whether there was any. */
  const addPasted = (list: FileList | undefined | null) => {
    const images = imagesFrom(list);
    const files = attachmentsFrom(list);
    const editor = editorRef.current;
    if (!editor || images.length + files.length === 0) {
      return false;
    }
    startUploads();
    void addImages(editor, images).then(() => addFiles(editor, files));
    return true;
  };

  // Each new document, recorded before the placeholder builds its hints for it (they're built as the state is made).
  const [drawn] = useState<{ doc: ProseMirrorNode | null }>(() => ({ doc: null }));
  const editor = useEditor({
    extensions: [
      ...extensions(profile, { mediaUrl: (key) => mediaUrls.get(key) }).map((extension) =>
        extension === TableOfContents ? EditorTableOfContents : extension,
      ),
      Extension.create({
        name: "drawnDoc",
        // Ahead of the placeholder's plugin, whose state is made after this one's.
        priority: 1000,
        addProseMirrorPlugins: () => [
          new Plugin({
            state: {
              init: (_, state) => {
                drawn.doc = state.doc;
              },
              apply: (tr) => {
                drawn.doc = tr.doc;
              },
            },
          }),
        ],
      }),
      Placeholder.configure({
        // Inside blocks too, for a step's title and body; not in lists or tables (no hint there).
        includeChildren: true,
        // Bare, the line being written says how to add blocks once there's some text.
        // A new collapsible block reads as empty (in a quote or list, or as all there is): its summary has a hint of its own.
        placeholder: ({ editor, node, pos }) => {
          if (holdsDetails(node)) {
            return "";
          }
          if (node.type.name === "detailsSummary") {
            return "Summary";
          }
          if (editor.isEmpty || !bare) {
            return editor.isEmpty ? (placeholder ?? "") : "";
          }
          // Only lines get hints, not the blocks holding them (a new, empty steps block).
          if (!node.isTextblock) {
            return "";
          }
          if (node.type.name === "stepTitle") {
            return "Step title";
          }
          // In the document the hints are for (see `drawn`): the editor's own state is still the one before the edit.
          const doc = drawn.doc ?? editor.state.doc;
          const parent = pos <= doc.content.size ? doc.resolve(pos).parent.type.name : "doc";
          if (parent === "step") {
            return canUpload ? STEP_HINT : STEP_HINT_NO_IMAGES;
          }
          return parent !== "doc" ? "" : node.type.name === "heading" ? "Heading" : SLASH_HINTS[profile];
        },
      }),
    ],
    content: initial,
    immediatelyRender: false,
    editorProps: {
      attributes: () => ({
        role: "textbox",
        "aria-multiline": "true",
        ...(label && { "aria-label": label }),
        ...(labelledBy && { "aria-labelledby": labelledBy }),
        ...aria.current,
        class: cn(
          "rich-text outline-none",
          bare ? cn("min-h-32 text-base", profile === "article" && "article-text") : "min-h-20 px-2.5 py-2 text-base md:text-sm",
        ),
      }),
      handleKeyDown: (_view, event) => {
        if (menuKeys.current?.(event)) {
          return true;
        }
        // With no toolbar, links are a shortcut away too.
        if (bare && event.key === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
          setPrompt("link");
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => addPasted(event.clipboardData?.files),
      handleDrop: (_view, event) => {
        if (!addPasted(event.dataTransfer?.files)) {
          return false;
        }
        event.preventDefault();
        return true;
      },
    },
    onCreate: ({ editor }) => {
      // Text with something this editor doesn't know: shown as far as it can be, read-only, and never sent.
      if (initial && !readableBy(editor.schema, initial)) {
        unreadableRef.current = true;
        setUnreadable(true);
        editor.commands.setContent(readablePart(editor.schema, initial) ?? "", { emitUpdate: false });
        editor.setEditable(false);
      }
      onReadable?.(!unreadableRef.current);
      editorRef.current = editor;
      if (outerRef) {
        outerRef.current = editor;
      }
      onCreate?.(editor);
    },
    onUpdate: ({ editor }) => {
      // What it was given stays what it sends.
      if (unreadableRef.current) {
        return;
      }
      const doc = editor.getJSON();
      setValue(isEmptyDoc(doc) ? "" : JSON.stringify(doc));
      onChange?.(editor);
    },
  });

  useEffect(() => {
    aria.current = unreadable
      ? // Locked, and why: read with the text box, not only as the page loads.
        { "aria-readonly": "true", "aria-describedby": unreadableNote }
      : invalid
        ? { "aria-invalid": "true", ...(describedBy && { "aria-describedby": describedBy }) }
        : {};
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [editor, invalid, describedBy, unreadable, unreadableNote]);

  // While an image uploads, its form doesn't submit (it would save without the image). Stopped
  // on the form itself, before React's handler for the form's action or onSubmit sees the event.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const form = root.current?.closest("form");
    if (!form || (uploading === 0 && !unreadable)) {
      return;
    }
    const hold = (event: SubmitEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setHeld(true);
      // Saving is paused: say why where it's seen, wherever Save was pressed (the top bar, the foot of a long text).
      // Focus too, so a screen reader reads it again (a press of Save otherwise says nothing).
      if (unreadable) {
        const note = document.getElementById(unreadableNote);
        note?.scrollIntoView({ block: "center" });
        note?.focus();
      }
    };
    form.addEventListener("submit", hold);
    return () => form.removeEventListener("submit", hold);
  }, [uploading, unreadable, unreadableNote]);

  // Images are files too: with any attachment among the uploads, they're all "files".
  const noun = attaching > 0 ? "file" : "image";
  return (
    <div ref={root} className="flex w-full flex-col gap-1">
      {/* Above the text, where Save's top bar is: a held save scrolls it into view too. */}
      {unreadable && (
        <p id={unreadableNote} role="alert" tabIndex={-1} className="text-sm text-destructive outline-none">
          Part of this text can&apos;t be shown here, likely because of an update that&apos;s just gone out. Reload the page to
          edit it: nothing on this page can be saved until then, and the saved text stays as it is.
        </p>
      )}
      <div
        className={cn(
          !bare &&
            "w-full rounded-lg border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
          !bare && invalid && "border-destructive ring-3 ring-destructive/20",
        )}
      >
        {editor && !bare && <Toolbar editor={editor} onPrompt={setPrompt} className="border-b px-1 py-1" />}
        <EditorContent editor={editor} />
        {editor && bare && (
          <>
            <div ref={menus} />
            <SelectionBar editor={editor} onPrompt={setPrompt} host={menusHost} />
            <SlashMenu
              editor={editor}
              host={menusHost}
              keysRef={menuKeys}
              profile={profile}
              onPrompt={setPrompt}
              onImage={canUpload ? () => fileInput.current?.click() : undefined}
              onFile={canAttach ? () => attachInput.current?.click() : undefined}
            />
          </>
        )}
        {canUpload && editor && (
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              startUploads();
              void addImages(editor, [...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        )}
        {canAttach && editor && (
          <input
            ref={attachInput}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            hidden
            aria-label="Files to attach"
            onChange={(event) => {
              startUploads();
              void addFiles(editor, [...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        )}
        <input type="hidden" name={name} value={value} />
        {editor && <EditorDialog editor={editor} kind={prompt} onClose={() => setPrompt(null)} />}
      </div>
      {uploading > 0 &&
        (held ? (
          <p role="alert" className="text-sm text-destructive">
            Wait for the {uploading === 1 ? noun : `${noun}s`} to finish uploading, then try again.
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Uploading {uploading === 1 ? noun : `${uploading} ${noun}s`}…
          </p>
        ))}
      {uploadError && (
        <p role="alert" className="text-sm text-destructive">
          {uploadError}
        </p>
      )}
    </div>
  );
}

const SIZE_LABELS: Record<(typeof IMAGE_SIZES)[number], string> = {
  "25": "Small",
  "50": "Medium",
  "75": "Large",
  "100": "Full width",
};
const ALIGN_ICONS: Record<(typeof IMAGE_ALIGNMENTS)[number], LucideIcon> = {
  left: AlignLeftIcon,
  center: AlignCenterIcon,
  right: AlignRightIcon,
};

/** Whether a block is or holds a collapsible block. */
function holdsDetails(node: ProseMirrorNode): boolean {
  let found = node.type.name === "details";
  node.descendants((child) => {
    found ||= child.type.name === "details";
    return !found;
  });
  return found;
}

/** What the / menu offers in each profile; the empty line being written says so (bare editors). */
const SLASH_HINTS: Record<Profile, string> = {
  comment: "",
  post: "Type / for lists, images and more",
  changelog: "Type / for headings, lists, images and more",
  article: "Type / for headings, lists, tables and more",
};

/** In a step's body, the / menu has only the blocks a step holds (see Step in @tuti/content). */
const STEP_HINT = "Type / for lists, code and images";
/** Without uploads (no media storage set up), there's no Image in the menu. */
const STEP_HINT_NO_IMAGES = "Type / for lists and code";
const STEP_BLOCKS = new Set(["Bulleted list", "Numbered list", "Code block", "Code tabs", "Image", "File"]);

type Block = { label: string; icon: LucideIcon; run: () => void };

/** The blocks a profile has, for the / menu. */
function blocks(editor: Editor, profile: Profile, onPrompt: (kind: Prompt) => void, onImage?: () => void, onFile?: () => void): Block[] {
  if (profile === "comment") {
    return [];
  }
  const chain = () => editor.chain().focus();
  const long = profile === "changelog" || profile === "article";
  // A collapsible block's body takes no headings or collapsible blocks of its own.
  const inDetails = editor.isActive("details");
  const all: Block[] = [
    ...(long && !inDetails
      ? [
          { label: "Heading", icon: Heading2Icon, run: () => chain().setHeading({ level: 2 }).run() },
          { label: "Subheading", icon: Heading3Icon, run: () => chain().setHeading({ level: 3 }).run() },
        ]
      : []),
    { label: "Bulleted list", icon: ListIcon, run: () => chain().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrderedIcon, run: () => chain().toggleOrderedList().run() },
    ...(long ? [{ label: "Quote", icon: QuoteIcon, run: () => chain().toggleBlockquote().run() }] : []),
    { label: "Code block", icon: SquareCodeIcon, run: () => chain().toggleCodeBlock().run() },
    ...(profile === "article"
      ? [
          { label: "Table", icon: TableIcon, run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
          { label: "Code tabs", icon: AppWindowIcon, run: () => insertCodeTabs(editor) },
        ]
      : []),
    ...(profile === "article" && !inDetails ? [{ label: "Steps", icon: FootprintsIcon, run: () => chain().setSteps().run() }] : []),
    // A summary line that opens to show more (FAQs); the cursor starts in the summary.
    ...(profile === "article" && !inDetails ? [{ label: "Collapsible", icon: ListCollapseIcon, run: () => chain().setDetails().run() }] : []),
    // Only on a top-level line, beside the headings it lists (parseDoc refuses it in a list, quote or table).
    ...(profile === "article" && editor.state.selection.$from.depth === 1
      ? [{ label: "Table of contents", icon: TableOfContentsIcon, run: () => chain().insertContent({ type: TableOfContents.name }).run() }]
      : []),
    ...(long ? [{ label: "Divider", icon: MinusIcon, run: () => chain().setHorizontalRule().run() }] : []),
    ...(onImage ? [{ label: "Image", icon: ImageIcon, run: onImage }] : []),
    { label: "Video", icon: VideoIcon, run: () => onPrompt("video") },
    ...(onFile ? [{ label: "File", icon: PaperclipIcon, run: onFile }] : []),
  ];
  return editor.isActive("step") ? all.filter((block) => STEP_BLOCKS.has(block.label)) : all;
}

/** Code tabs (articles): two to start with, the cursor in the first. */
function insertCodeTabs(editor: Editor) {
  const tab = (n: number) => ({ type: "codeBlock", attrs: { filename: `Tab ${n}` } });
  editor.chain().focus().insertContent({ type: "codeTabs", content: [tab(1), tab(2)] }).run();
  // It leaves the cursor in the last tab.
  const { $from } = editor.state.selection;
  if ($from.depth >= 2 && $from.node(-1).type.name === "codeTabs") {
    editor.commands.setTextSelection($from.start(-1) + 1);
  }
}

/** The code tab the cursor is in: its position in the document and the group's. */
function codeTab(editor: Editor) {
  const { $from } = editor.state.selection;
  return $from.depth >= 2 && $from.parent.type.name === "codeBlock" && $from.node(-1).type.name === "codeTabs" ? $from : null;
}

/** A tab after the one the cursor is in, the cursor in it. */
function addCodeTab(editor: Editor) {
  const $tab = codeTab(editor);
  if (!$tab || $tab.node(-1).childCount >= MAX_CODE_TABS) {
    return;
  }
  const at = $tab.after();
  editor
    .chain()
    .focus()
    .command(markTabsEdit)
    .insertContentAt(at, { type: "codeBlock", attrs: { filename: newTabLabel($tab.node(-1).content.content.map((tab) => tab.attrs.filename as unknown)) } })
    .setTextSelection(at + 1)
    .run();
}

/** Lets an edit of the tabs themselves through CodeTabs' guard. */
const markTabsEdit = ({ tr }: { tr: Transaction }) => {
  tr.setMeta(CODE_TABS_EDIT, true);
  return true;
};

/** Removes the tab the cursor is in; with one left, it's a code block of its own (with its file name). */
function removeCodeTab(editor: Editor) {
  const $tab = codeTab(editor);
  if (!$tab) {
    return;
  }
  const group = $tab.node(-1);
  if (group.childCount > 2) {
    editor.chain().focus().command(markTabsEdit).deleteRange({ from: $tab.before(), to: $tab.after() }).run();
  } else {
    const other = group.child($tab.index(-1) === 0 ? 1 : 0);
    editor
      .chain()
      .focus()
      .command(markTabsEdit)
      .insertContentAt({ from: $tab.before(-1), to: $tab.after(-1) }, other.toJSON())
      .setTextSelection($tab.before(-1) + 1)
      .run();
  }
}

/** Articles' code blocks have a file name (and code tabs). */
const namedCode = (editor: Editor) => !!editor.schema.nodes.codeTabs && editor.isActive("codeBlock");

/** What's typed after a / that starts the line being written (the cursor at its end), or null. */
function slashQuery(editor: Editor): string | null {
  const { empty, $from } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) {
    return null;
  }
  return /^\/([\p{L} ]{0,20})$/u.exec($from.parent.textContent)?.[1]?.trim().toLowerCase() ?? null;
}

// Fixed, so a card around the editor (overflow hidden) doesn't cut them off.
const SLASH_MENU = { strategy: "fixed", placement: "bottom-start", offset: 6, flip: true, shift: { padding: 8 } } as const;
const SELECTION_BAR = { strategy: "fixed", placement: "top", offset: 8, flip: true, shift: { padding: 8 } } as const;
const showSlashMenu = ({ editor }: { editor: Editor }) => editor.isEditable && slashQuery(editor) !== null;
// Selected text or an image, or the cursor in a table (for its rows and columns) or an article's code block (its file
// name, tabs); a file has nothing to format.
const showSelectionBar = ({ editor }: { editor: Editor }) =>
  editor.isEditable && (!editor.state.selection.empty || editor.isActive("table") || namedCode(editor)) && !editor.isActive("file");

/** Typing / at the start of a line lists the blocks; typing more filters them. Arrows and Enter pick one, Escape closes it. */
function SlashMenu({
  editor,
  host,
  keysRef,
  profile,
  onPrompt,
  onImage,
  onFile,
}: {
  editor: Editor;
  host: () => HTMLElement;
  keysRef: React.RefObject<((event: KeyboardEvent) => boolean) | null>;
  profile: Profile;
  onPrompt: (kind: Prompt) => void;
  onImage?: () => void;
  /** Attach a file (articles). */
  onFile?: () => void;
}) {
  const query = useEditorState({ editor, selector: ({ editor }) => slashQuery(editor) });
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // A new query starts at the top; leaving the / line forgets an Escape.
  const [seen, setSeen] = useState(query);
  if (query !== seen) {
    setSeen(query);
    setActive(0);
    if (query === null) {
      setDismissed(false);
    }
  }
  const matches = query === null || dismissed ? [] : blocks(editor, profile, onPrompt, onImage, onFile).filter((block) => block.label.toLowerCase().includes(query));
  const current = Math.min(active, matches.length - 1);

  const choose = (block: Block) => {
    const { $from } = editor.state.selection;
    editor.chain().focus().deleteRange({ from: $from.start(), to: $from.pos }).run();
    block.run();
  };

  useEffect(() => {
    if (matches.length === 0) {
      return;
    }
    keysRef.current = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setActive((current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        choose(matches[current]!);
      } else if (event.key === "Escape") {
        setDismissed(true);
      } else {
        return false;
      }
      return true;
    };
    return () => {
      keysRef.current = null;
    };
  });

  return (
    <BubbleMenu editor={editor} pluginKey="slashMenu" shouldShow={showSlashMenu} appendTo={host} options={SLASH_MENU} className="z-50">
      {matches.length > 0 && (
        <div
          role="listbox"
          aria-label="Blocks"
          className="flex max-h-72 w-56 flex-col overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {matches.map((block, index) => (
            <div
              key={block.label}
              role="option"
              aria-selected={index === current}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground"
              // Keep focus (and the line) in the text.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(block)}
            >
              <block.icon />
              {block.label}
            </div>
          ))}
        </div>
      )}
    </BubbleMenu>
  );
}

/** Formatting over selected text, and an image's, a table's or a code block's controls while one is picked. */
function SelectionBar({ editor, onPrompt, host }: { editor: Editor; onPrompt: (kind: Prompt) => void; host: () => HTMLElement }) {
  // In a table or code with nothing selected, the bar sits above it rather than over the line being written.
  const table = useCallback(() => {
    const { selection } = editor.state;
    const { $from } = selection;
    for (let depth = $from.depth; depth > 0 && selection.empty; depth--) {
      const name = $from.node(depth).type.name;
      if (name === "table" || name === "codeTabs" || (name === "codeBlock" && namedCode(editor) && !codeTab(editor))) {
        const dom = editor.view.nodeDOM($from.before(depth));
        return dom instanceof HTMLElement ? dom : null;
      }
    }
    return null;
  }, [editor]);
  // Tab from the text goes straight to the buttons: the plugin makes their wrapper focusable as it starts (before this runs).
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bar.current) {
      bar.current.tabIndex = -1;
    }
  });
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionBar"
      shouldShow={showSelectionBar}
      getReferencedVirtualElement={table}
      appendTo={host}
      options={SELECTION_BAR}
      className="z-50"
      ref={bar}
    >
      <Toolbar editor={editor} onPrompt={onPrompt} className="rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10" />
    </BubbleMenu>
  );
}

function Toolbar({ editor, onPrompt, className }: { editor: Editor; onPrompt: (kind: Prompt) => void; className?: string }) {
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      code: editor.isActive("code"),
      link: editor.isActive("link"),
      image: editor.isActive("image") ? (editor.getAttributes("image") as { width: string; align: string }) : null,
      table: editor.isActive("table"),
      codeBlock: namedCode(editor) ? { tabs: codeTab(editor)?.node(-1).childCount ?? 0 } : null,
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div role="toolbar" aria-label="Formatting" className={cn("flex flex-wrap items-center gap-0.5", className)}>
      {!active.image && !active.codeBlock && (
        <>
          <Tool icon={BoldIcon} label="Bold" active={active.bold} onClick={() => chain().toggleBold().run()} />
          <Tool icon={ItalicIcon} label="Italic" active={active.italic} onClick={() => chain().toggleItalic().run()} />
          <Tool icon={CodeIcon} label="Code" active={active.code} onClick={() => chain().toggleCode().run()} />
          <Tool
            icon={LinkIcon}
            label={active.link ? "Remove link" : "Link"}
            active={active.link}
            onClick={() => (active.link ? chain().extendMarkRange("link").unsetLink().run() : onPrompt("link"))}
          />
        </>
      )}
      {active.image && (
        <div role="group" aria-label="Image" className="flex flex-wrap items-center gap-0.5">
          {IMAGE_SIZES.map((size) => (
            <Button
              key={size}
              type="button"
              variant={active.image?.width === size ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={active.image?.width === size}
              aria-label={SIZE_LABELS[size]}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chain().updateAttributes("image", { width: size }).run()}
            >
              {size}%
            </Button>
          ))}
          {IMAGE_ALIGNMENTS.map((align) => (
            <Tool
              key={align}
              icon={ALIGN_ICONS[align]}
              label={`Align ${align}`}
              active={active.image?.align === align}
              onClick={() => chain().updateAttributes("image", { align }).run()}
            />
          ))}
          <Tool icon={TextIcon} label="Alt text" active={false} onClick={() => onPrompt("alt")} />
        </div>
      )}
      {active.codeBlock && (
        <div role="group" aria-label="Code" className="flex flex-wrap items-center gap-0.5">
          {(
            [
              [active.codeBlock.tabs ? "Rename tab" : "File name", () => onPrompt("filename")],
              ...(active.codeBlock.tabs && active.codeBlock.tabs < MAX_CODE_TABS ? [["Add tab", () => addCodeTab(editor)]] : []),
              ...(active.codeBlock.tabs ? [["Remove tab", () => removeCodeTab(editor)]] : []),
            ] as [string, () => void][]
          ).map(([label, onClick]) => (
            <Button key={label} type="button" variant="ghost" size="sm" onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
              {label}
            </Button>
          ))}
        </div>
      )}
      {active.table && (
        <div role="group" aria-label="Table" className="flex flex-wrap items-center gap-0.5 border-l pl-1">
          {(
            [
              ["Add row", () => chain().addRowAfter().run()],
              ["Add column", () => chain().addColumnAfter().run()],
              ["Delete row", () => chain().deleteRow().run()],
              ["Delete column", () => chain().deleteColumn().run()],
              ["Delete table", () => chain().deleteTable().run()],
            ] as const
          ).map(([label, onClick]) => (
            <Button key={label} type="button" variant="ghost" size="sm" onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
              {label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Tool({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      title={label}
      // Keep focus (and the selection) in the text while clicking; keyboard users still reach it with Tab.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon />
    </Button>
  );
}

/** Links get https:// when typed without a protocol, and mailto: when they're an email address. */
function normaliseHref(input: string): string {
  const value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }
  return /^[^\s/@]+@[^\s/@]+$/.test(value) ? `mailto:${value}` : `https://${value}`;
}

const DIALOGS: Record<Prompt, { title: string; label: string; placeholder?: string; submit: string }> = {
  link: { title: "Add a link", label: "Link", placeholder: "https://example.com", submit: "Add link" },
  video: {
    title: "Embed a video",
    label: "Video link (YouTube, Vimeo or Loom)",
    placeholder: "https://www.youtube.com/watch?v=…",
    submit: "Embed video",
  },
  alt: { title: "Describe the image", label: "Alt text, for people who can't see it", submit: "Save" },
  filename: { title: "Name the code", label: "File name, shown above the code (in code tabs, the tab's label)", submit: "Save" },
};

function EditorDialog({ editor, kind, onClose }: { editor: Editor; kind: Prompt | null; onClose: () => void }) {
  const inputId = useId();
  const errorId = useId();
  const [error, setError] = useState<string>();
  const dialog = kind && DIALOGS[kind];

  const close = () => {
    setError(undefined);
    onClose();
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    // The dialog sits inside the post or comment form in React's tree: don't submit that.
    event.preventDefault();
    event.stopPropagation();
    const input = String(new FormData(event.currentTarget).get("value") ?? "");
    if (kind === "link") {
      const href = normaliseHref(input);
      if (!isSafeLink(href)) {
        setError("Links must start with http://, https:// or mailto:.");
        return;
      }
      const chain = editor.chain().focus();
      if (editor.state.selection.empty && !editor.isActive("link")) {
        chain.insertContent({ type: "text", text: input.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
      } else {
        chain.extendMarkRange("link").setLink({ href }).run();
      }
    } else if (kind === "video") {
      const video = parseVideoUrl(input);
      if (!video) {
        setError("Paste a YouTube, Vimeo or Loom link.");
        return;
      }
      editor.chain().focus().setVideo(video).run();
    } else if (kind === "alt") {
      editor.chain().focus().updateAttributes("image", { alt: input.trim() }).run();
    } else if (kind === "filename") {
      if (!input.trim() && codeTab(editor)) {
        setError("A tab needs a label.");
        return;
      }
      // As save checks it (after trimming), so the dialog says what's wrong rather than the save.
      if (input.trim() && !isCodeFilename(input.trim())) {
        setError(`A file name is one line of up to ${MAX_FILENAME_LENGTH} characters.`);
        return;
      }
      // Only the block at the cursor, even with a selection running into another tab.
      editor
        .chain()
        .focus()
        .setTextSelection(editor.state.selection.from)
        .command(markTabsEdit)
        .updateAttributes("codeBlock", { filename: input.trim() || null })
        .run();
    }
    close();
  };

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && close()}>
      {/* Back to the text, with its selection (focusing the element itself would put the cursor at the start).
          Opened from a shortcut or a menu, there's no button to go back to. */}
      <DialogContent
        finalFocus={() => {
          editor.commands.focus();
          return false;
        }}
      >
        {dialog && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{dialog.title}</DialogTitle>
            </DialogHeader>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor={inputId}>{dialog.label}</FieldLabel>
              <Input
                id={inputId}
                name="value"
                autoComplete="off"
                placeholder={dialog.placeholder}
                defaultValue={
                  kind === "alt"
                    ? String(editor.getAttributes("image").alt ?? "")
                    : kind === "filename"
                      ? // The block it renames: the one at the selection's start.
                        String(editor.state.selection.$from.parent.attrs.filename ?? "")
                      : undefined
                }
                maxLength={kind === "alt" ? MAX_ALT_LENGTH : undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                required={kind !== "alt" && kind !== "filename"}
                autoFocus
              />
              {error && <FieldError id={errorId}>{error}</FieldError>}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit">{dialog.submit}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
