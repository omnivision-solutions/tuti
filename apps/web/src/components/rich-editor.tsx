"use client";

import { Placeholder } from "@tiptap/extensions";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  extensions,
  IMAGE_ALIGNMENTS,
  IMAGE_SIZES,
  isEmptyDoc,
  isSafeLink,
  MAX_ALT_LENGTH,
  parseVideoUrl,
  type Profile,
} from "@tuti/content";
import { cn } from "cn";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CodeIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  type LucideIcon,
  SquareCodeIcon,
  TextIcon,
  VideoIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createUpload, finishUpload, uploadStatus } from "@/server/media";

type Prompt = "link" | "video" | "alt";
/** Where images can be uploaded to; without it, the editor has no images. */
export type EditorUploads = { projectSlug: string; mediaBaseUrl: string };

/**
 * The rich text editor for one content profile (see @tuti/content). It submits the
 * document as JSON in a hidden input called `name` (empty when there's nothing in it);
 * the server validates it against the same profile. Remount it (change its `key`) to clear it.
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
}) {
  const [value, setValue] = useState("");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string>();
  const canUpload = profile === "post" && !!uploads;

  const addImages = async (editor: Editor, files: File[]) => {
    if (!uploads) {
      return;
    }
    setUploadError(undefined);
    for (const file of files) {
      setUploading((n) => n + 1);
      const result = await uploadImage(uploads.projectSlug, file);
      setUploading((n) => n - 1);
      if ("error" in result) {
        setUploadError(result.error);
      } else {
        editor.chain().focus().setImage(result).run();
      }
    }
  };
  // Paste and drop handlers are set up with the editor, before `editor` below has a value.
  const editorRef = useRef<Editor | null>(null);
  // The editor reads its attributes on every update; the effect below keeps the error state current.
  const aria = useRef<Record<string, string>>({});

  const imagesFrom = (list: FileList | undefined | null) =>
    canUpload ? [...(list ?? [])].filter((file) => file.type.startsWith("image/")) : [];

  const editor = useEditor({
    extensions: [
      ...extensions(profile, { mediaBaseUrl: uploads?.mediaBaseUrl }),
      Placeholder.configure({ placeholder }),
    ],
    immediatelyRender: false,
    editorProps: {
      attributes: () => ({
        role: "textbox",
        "aria-multiline": "true",
        ...(label && { "aria-label": label }),
        ...(labelledBy && { "aria-labelledby": labelledBy }),
        ...aria.current,
        class: "rich-text min-h-20 px-2.5 py-2 text-base outline-none md:text-sm",
      }),
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
    },
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON();
      setValue(isEmptyDoc(doc) ? "" : JSON.stringify(doc));
    },
  });

  useEffect(() => {
    aria.current = invalid ? { "aria-invalid": "true", ...(describedBy && { "aria-describedby": describedBy }) } : {};
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr);
    }
  }, [editor, invalid, describedBy]);

  return (
    <div className="flex w-full flex-col gap-1">
      <div
        className={cn(
          "w-full rounded-lg border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
          invalid && "border-destructive ring-3 ring-destructive/20",
        )}
      >
        {editor && (
          <Toolbar
            editor={editor}
            profile={profile}
            onPrompt={setPrompt}
            onImages={canUpload ? (files) => addImages(editor, files) : undefined}
          />
        )}
        <EditorContent editor={editor} />
        <input type="hidden" name={name} value={value} />
        {editor && <EditorDialog editor={editor} kind={prompt} onClose={() => setPrompt(null)} />}
      </div>
      {uploading > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          Uploading {uploading === 1 ? "image" : `${uploading} images`}…
        </p>
      )}
      {uploadError && (
        <p role="alert" className="text-sm text-destructive">
          {uploadError}
        </p>
      )}
    </div>
  );
}

/** Uploads straight to media storage, then waits until the image is processed. */
async function uploadImage(
  projectSlug: string,
  file: File,
): Promise<{ mediaId: string; w: number; h: number } | { error: string }> {
  const created = await createUpload(projectSlug, { type: file.type, size: file.size });
  if ("error" in created) {
    return created;
  }
  const put = await fetch(created.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } }).catch(
    () => null,
  );
  if (!put?.ok) {
    return { error: "The upload failed. Try again." };
  }
  const finished = await finishUpload(created.mediaId);
  if (finished.error) {
    return { error: finished.error };
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await uploadStatus(created.mediaId);
    if ("error" in status) {
      return status;
    }
    if (status.status === "READY") {
      return { mediaId: created.mediaId, w: status.width, h: status.height };
    }
    if (status.status === "FAILED") {
      return { error: `${file.name} couldn't be used as an image` };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { error: "The image is taking too long. Try again." };
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

function Toolbar({
  editor,
  profile,
  onPrompt,
  onImages,
}: {
  editor: Editor;
  profile: Profile;
  onPrompt: (kind: Prompt) => void;
  onImages?: (files: File[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      code: editor.isActive("code"),
      link: editor.isActive("link"),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      codeBlock: editor.isActive("codeBlock"),
      image: editor.isActive("image") ? (editor.getAttributes("image") as { width: string; align: string }) : null,
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b px-1 py-1">
      <Tool icon={BoldIcon} label="Bold" active={active.bold} onClick={() => chain().toggleBold().run()} />
      <Tool icon={ItalicIcon} label="Italic" active={active.italic} onClick={() => chain().toggleItalic().run()} />
      <Tool icon={CodeIcon} label="Code" active={active.code} onClick={() => chain().toggleCode().run()} />
      <Tool
        icon={LinkIcon}
        label={active.link ? "Remove link" : "Link"}
        active={active.link}
        onClick={() => (active.link ? chain().extendMarkRange("link").unsetLink().run() : onPrompt("link"))}
      />
      {profile === "post" && (
        <>
          <Tool
            icon={ListIcon}
            label="Bulleted list"
            active={active.bulletList}
            onClick={() => chain().toggleBulletList().run()}
          />
          <Tool
            icon={ListOrderedIcon}
            label="Numbered list"
            active={active.orderedList}
            onClick={() => chain().toggleOrderedList().run()}
          />
          <Tool
            icon={SquareCodeIcon}
            label="Code block"
            active={active.codeBlock}
            onClick={() => chain().toggleCodeBlock().run()}
          />
          {onImages && (
            <>
              <Tool icon={ImageIcon} label="Image" active={false} onClick={() => fileInput.current?.click()} />
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                hidden
                onChange={(event) => {
                  onImages([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
            </>
          )}
          <Tool icon={VideoIcon} label="Video" active={false} onClick={() => onPrompt("video")} />
        </>
      )}
      {active.image && (
        <div role="group" aria-label="Image" className="flex flex-wrap items-center gap-0.5 border-l pl-1">
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
      <DialogContent>
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
