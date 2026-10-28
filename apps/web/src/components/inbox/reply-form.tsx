"use client";

import { PaperclipIcon, SparklesIcon, XIcon } from "lucide-react";
import { useId, useRef, useState, useTransition } from "react";

import { fileSize } from "@/components/inbox/message-attachments";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { draftReplyWithAi, replyInConversation, uploadReplyAttachment } from "@/server/inbox";

type Kind = "reply" | "note";
type Upload = { key: string; name: string; size: number; id?: string; error?: string };

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The team's reply box, or a note only the team sees (never sent); ⌘/Ctrl+Enter sends. Each keeps its
 * own draft. Files attached upload straight to the media storage and go with what's sent.
 */
export function ReplyForm({
  projectSlug,
  number,
  draftWithAi = "off",
}: {
  projectSlug: string;
  number: number;
  /** "Draft with AI": shown when the server has AI and docs search ("on"), disabled while the project is out of AI credits ("paused"). */
  draftWithAi?: "on" | "paused" | "off";
}) {
  const [kind, setKind] = useState<Kind>("reply");
  const [drafts, setDrafts] = useState<Record<Kind, string>>({ reply: "", note: "" });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const [drafting, startDrafting] = useTransition();
  const [notice, setNotice] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const note = kind === "note";
  const uploading = uploads.some((u) => !u.id && !u.error);

  const update = (key: string, change: Partial<Upload>) => setUploads((current) => current.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const attach = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const key = crypto.randomUUID();
      setUploads((current) => [...current, { key, name: file.name, size: file.size }]);
      if (file.size > MAX_FILE_BYTES) {
        update(key, { error: "Over 10 MB" });
        continue;
      }
      void (async () => {
        // However it fails (the network, the server), the file says so, rather than uploading for ever.
        try {
          const started = await uploadReplyAttachment(projectSlug, { filename: file.name, contentType: file.type || "application/octet-stream", size: file.size });
          if ("error" in started) {
            update(key, { error: started.error });
            return;
          }
          const put = await fetch(started.uploadUrl, { method: "PUT", body: file, headers: { "content-type": started.contentType } });
          update(key, put.ok ? { id: started.id } : { error: "Couldn't upload it" });
        } catch {
          update(key, { error: "Couldn't upload it" });
        }
      })();
    }
    if (picker.current) {
      picker.current.value = "";
    }
  };

  // A reply drafted from the docs, into the reply box (below anything already written there), to edit and send.
  const draft = () =>
    startDrafting(async () => {
      setNotice(undefined);
      const result = await draftReplyWithAi(projectSlug, number).catch(() => ({ error: "The AI couldn't draft a reply: try again" }));
      if ("error" in result) {
        setNotice(result.error);
      } else if (result.draft === null) {
        setNotice(result.reason);
      } else {
        const text = result.draft;
        setKind("reply");
        setDrafts((current) => ({ ...current, reply: current.reply.trim() ? `${current.reply.trimEnd()}\n\n${text}` : text }));
      }
    });

  const send = () =>
    startTransition(async () => {
      const ids = uploads.flatMap((u) => (u.id ? [u.id] : []));
      const result = await replyInConversation(projectSlug, number, drafts[kind], note, ids);
      setError(result.error);
      if (!result.error) {
        setDrafts((current) => ({ ...current, [kind]: "" }));
        setUploads([]);
      }
    });

  return (
    <form
      ref={form}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Tabs
        value={kind}
        onValueChange={(value) => {
          setKind(value as Kind);
          setError(undefined);
        }}
      >
        <TabsList>
          <TabsTrigger value="reply">Reply</TabsTrigger>
          <TabsTrigger value="note">Note</TabsTrigger>
        </TabsList>
      </Tabs>
      <Field data-invalid={error ? true : undefined}>
        <Textarea
          aria-label={note ? "Note" : "Reply"}
          placeholder={note ? "Write a note only your team sees…" : "Write a reply…"}
          value={drafts[kind]}
          onChange={(event) => setDrafts((current) => ({ ...current, [kind]: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !pending && !uploading) {
              event.preventDefault();
              form.current?.requestSubmit();
            }
          }}
          rows={4}
          className={note ? "border-dashed bg-highlight/40" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Field>
      {uploads.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Files to send">
          {uploads.map((u) => (
            <li key={u.key} className="flex min-w-0 items-center gap-1.5 text-sm">
              <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{u.name}</span>
              <span className={u.error ? "shrink-0 text-xs text-destructive" : "shrink-0 text-xs text-muted-foreground"}>
                {u.error ?? (u.id ? fileSize(u.size) : "Uploading…")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${u.name}`}
                onClick={() => setUploads((current) => current.filter((other) => other.key !== u.key))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <input ref={picker} type="file" multiple hidden aria-label="Files to attach" onChange={(event) => attach(event.target.files)} />
          <Button type="button" variant="ghost" size="sm" onClick={() => picker.current?.click()}>
            <PaperclipIcon />
            Attach files
          </Button>
          {draftWithAi !== "off" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={drafting || draftWithAi === "paused"}
              title={draftWithAi === "paused" ? "This project is out of AI credits" : undefined}
              onClick={draft}
            >
              <SparklesIcon />
              {drafting ? "Drafting…" : "Draft with AI"}
            </Button>
          )}
        </div>
        <Button type="submit" disabled={pending || uploading}>
          {pending ? "Sending…" : note ? "Add note" : "Send"}
        </Button>
      </div>
    </form>
  );
}
