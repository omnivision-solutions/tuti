"use client";

import { Placeholder } from "@tiptap/extensions";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  extensions,
  IMAGE_ALIGNMENTS,
  IMAGE_SIZES,
  isEmptyDoc,
  isSafeLink,
  MAX_ALT_LENGTH,
  parseVideoUrl,
  type Doc,
  type MediaUrls,
  type Profile,
} from "@tuti/content";
import { cn } from "cn";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  type LucideIcon,
  MinusIcon,
  QuoteIcon,
  SquareCodeIcon,
  TableIcon,
  TextIcon,
  VideoIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { uploadImage } from "@/lib/upload-image";

type Prompt = "link" | "video" | "alt";
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
  onChange?: () => void;
  bare?: boolean;
}) {
  const [value, setValue] = useState(initial && !isEmptyDoc(initial) ? JSON.stringify(initial) : "");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string>();
  /** Someone tried to submit while images were uploading. */
  const [held, setHeld] = useState(false);
  const canUpload = profile !== "comment" && !!uploads;
  // The image node reads these as it draws, so uploads add their URLs here first.
  const [mediaUrls] = useState(() => new Map(Object.entries(uploads?.mediaUrls ?? {})));

  const addImages = async (editor: Editor, files: File[]) => {
    if (!uploads) {
      return;
    }
    setUploadError(undefined);
    setHeld(false);
    for (const file of files) {
      setUploading((n) => n + 1);
      const result = await uploadImage(uploads.projectSlug, file);
      setUploading((n) => n - 1);
      if ("error" in result) {
        setUploadError(result.error);
      } else {
        Object.entries(result.urls).forEach(([key, url]) => mediaUrls.set(key, url));
        editor.chain().focus().setImage(result).run();
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

  const imagesFrom = (list: FileList | undefined | null) =>
    canUpload ? [...(list ?? [])].filter((file) => file.type.startsWith("image/")) : [];

  const editor = useEditor({
    extensions: [
      ...extensions(profile, { mediaUrl: (key) => mediaUrls.get(key) }),
      Placeholder.configure({
        // Bare, the line being written says how to add blocks once there's some text.
        placeholder: ({ editor, node }) =>
          editor.isEmpty ? (placeholder ?? "") : !bare ? "" : node.type.name === "heading" ? "Heading" : SLASH_HINTS[profile],
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
      handlePaste: (_view, event) => {
        const files = imagesFrom(event.clipboardData?.files);
        if (files.length > 0 && editorRef.current) {
          void addImages(editorRef.current, files);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = imagesFrom(event.dataTransfer?.files);
        if (files.length > 0 && editorRef.current) {
          event.preventDefault();
          void addImages(editorRef.current, files);
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor }) => {
      editorRef.current = editor;
      if (outerRef) {
        outerRef.current = editor;
      }
    },
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON();
      setValue(isEmptyDoc(doc) ? "" : JSON.stringify(doc));
      onChange?.();
    },
  });

  useEffect(() => {
    aria.current = invalid ? { "aria-invalid": "true", ...(describedBy && { "aria-describedby": describedBy }) } : {};
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [editor, invalid, describedBy]);

  // While an image uploads, its form doesn't submit (it would save without the image). Stopped
  // on the form itself, before React's handler for the form's action or onSubmit sees the event.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const form = root.current?.closest("form");
    if (!form || uploading === 0) {
      return;
    }
    const hold = (event: SubmitEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setHeld(true);
    };
    form.addEventListener("submit", hold);
    return () => form.removeEventListener("submit", hold);
  }, [uploading]);

  return (
    <div ref={root} className="flex w-full flex-col gap-1">
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
            <SelectionBar editor={editor} onPrompt={setPrompt} />
            <SlashMenu
              editor={editor}
              keysRef={menuKeys}
              profile={profile}
              onPrompt={setPrompt}
              onImage={canUpload ? () => fileInput.current?.click() : undefined}
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
              void addImages(editor, [...(event.target.files ?? [])]);
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
            Wait for the {uploading === 1 ? "image" : "images"} to finish uploading, then try again.
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Uploading {uploading === 1 ? "image" : `${uploading} images`}…
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

/** What the / menu offers in each profile; the empty line being written says so (bare editors). */
const SLASH_HINTS: Record<Profile, string> = {
  comment: "",
  post: "Type / for lists, images and more",
  changelog: "Type / for headings, lists, images and more",
  article: "Type / for headings, lists, tables and more",
};

type Block = { label: string; icon: LucideIcon; run: () => void };

/** The blocks a profile has, for the / menu. */
function blocks(editor: Editor, profile: Profile, onPrompt: (kind: Prompt) => void, onImage?: () => void): Block[] {
  if (profile === "comment") {
    return [];
  }
  const chain = () => editor.chain().focus();
  const long = profile === "changelog" || profile === "article";
  return [
    ...(long
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
      ? [{ label: "Table", icon: TableIcon, run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() }]
      : []),
    ...(long ? [{ label: "Divider", icon: MinusIcon, run: () => chain().setHorizontalRule().run() }] : []),
    ...(onImage ? [{ label: "Image", icon: ImageIcon, run: onImage }] : []),
    { label: "Video", icon: VideoIcon, run: () => onPrompt("video") },
  ];
}

/** What's typed after a / that starts the line being written (the cursor at its end), or null. */
function slashQuery(editor: Editor): string | null {
  const { empty, $from } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) {
    return null;
  }
  return /^\/([\p{L} ]{0,20})$/u.exec($from.parent.textContent)?.[1]?.trim().toLowerCase() ?? null;
}

// Menus go on the page's body, so a card or panel around the editor doesn't cut them off.
const onBody = () => document.body;
const SLASH_MENU = { placement: "bottom-start", offset: 6, flip: true, shift: { padding: 8 } } as const;
const SELECTION_BAR = { placement: "top", offset: 8, flip: true, shift: { padding: 8 } } as const;
const showSlashMenu = ({ editor }: { editor: Editor }) => editor.isEditable && slashQuery(editor) !== null;
// Selected text or an image, or the cursor in a table (for its rows and columns).
const showSelectionBar = ({ editor }: { editor: Editor }) => editor.isEditable && (!editor.state.selection.empty || editor.isActive("table"));

/** Typing / at the start of a line lists the blocks; typing more filters them. Arrows and Enter pick one, Escape closes it. */
function SlashMenu({
  editor,
  keysRef,
  profile,
  onPrompt,
  onImage,
}: {
  editor: Editor;
  keysRef: React.RefObject<((event: KeyboardEvent) => boolean) | null>;
  profile: Profile;
  onPrompt: (kind: Prompt) => void;
  onImage?: () => void;
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
  const matches = query === null || dismissed ? [] : blocks(editor, profile, onPrompt, onImage).filter((block) => block.label.toLowerCase().includes(query));
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
    <BubbleMenu editor={editor} pluginKey="slashMenu" shouldShow={showSlashMenu} appendTo={onBody} options={SLASH_MENU} className="z-50">
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

/** Formatting over selected text, and an image's or a table's controls while one is picked. */
function SelectionBar({ editor, onPrompt }: { editor: Editor; onPrompt: (kind: Prompt) => void }) {
  // In a table with nothing selected, the bar sits above the table rather than over the line being written.
  const table = useCallback(() => {
    const { selection } = editor.state;
    const { $from } = selection;
    for (let depth = $from.depth; depth > 0 && selection.empty; depth--) {
      if ($from.node(depth).type.name === "table") {
        const dom = editor.view.nodeDOM($from.before(depth));
        return dom instanceof HTMLElement ? dom : null;
      }
    }
    return null;
  }, [editor]);
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionBar"
      shouldShow={showSelectionBar}
      getReferencedVirtualElement={table}
      appendTo={onBody}
      options={SELECTION_BAR}
      className="z-50"
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
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div role="toolbar" aria-label="Formatting" className={cn("flex flex-wrap items-center gap-0.5", className)}>
      {!active.image && (
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
                defaultValue={kind === "alt" ? String(editor.getAttributes("image").alt ?? "") : undefined}
                maxLength={kind === "alt" ? MAX_ALT_LENGTH : undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                required={kind !== "alt"}
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
