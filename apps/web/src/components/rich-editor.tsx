"use client";

import { Placeholder } from "@tiptap/extensions";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { extensions, isEmptyDoc, isSafeLink, parseVideoUrl, type Profile } from "@tuti/content";
import { cn } from "cn";
import {
  BoldIcon,
  CodeIcon,
  type LucideIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  SquareCodeIcon,
  VideoIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
}) {
  const [value, setValue] = useState("");
  const [prompt, setPrompt] = useState<"link" | "video" | null>(null);
  // The editor reads its attributes on every update; this effect keeps the error state current.
  const aria = useRef<Record<string, string>>({});
  const editor = useEditor({
    extensions: [...extensions(profile), Placeholder.configure({ placeholder })],
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
    <div
      className={cn(
        "w-full rounded-lg border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        invalid && "border-destructive ring-3 ring-destructive/20",
      )}
    >
      {editor && <Toolbar editor={editor} profile={profile} onPrompt={setPrompt} />}
      <EditorContent editor={editor} />
      <input type="hidden" name={name} value={value} />
      {editor && <UrlDialog editor={editor} kind={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}

function Toolbar({
  editor,
  profile,
  onPrompt,
}: {
  editor: Editor;
  profile: Profile;
  onPrompt: (kind: "link" | "video") => void;
}) {
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
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-0.5 border-b px-1 py-1">
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
          <Tool icon={VideoIcon} label="Video" active={false} onClick={() => onPrompt("video")} />
        </>
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

function UrlDialog({ editor, kind, onClose }: { editor: Editor; kind: "link" | "video" | null; onClose: () => void }) {
  const inputId = useId();
  const errorId = useId();
  const [error, setError] = useState<string>();
  const isLink = kind === "link";

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    // The dialog sits inside the post or comment form in React's tree: don't submit that.
    event.preventDefault();
    event.stopPropagation();
    const input = String(new FormData(event.currentTarget).get("url") ?? "");
    if (isLink) {
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
    } else {
      const video = parseVideoUrl(input);
      if (!video) {
        setError("Paste a YouTube, Vimeo or Loom link.");
        return;
      }
      editor.chain().focus().setVideo(video).run();
    }
    close();
  };

  const close = () => {
    setError(undefined);
    onClose();
  };

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isLink ? "Add a link" : "Embed a video"}</DialogTitle>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={inputId}>{isLink ? "Link" : "Video link (YouTube, Vimeo or Loom)"}</FieldLabel>
            <Input
              id={inputId}
              name="url"
              autoComplete="off"
              placeholder={isLink ? "https://example.com" : "https://www.youtube.com/watch?v=…"}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              required
              autoFocus
            />
            {error && <FieldError id={errorId}>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">{isLink ? "Add link" : "Embed video"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
