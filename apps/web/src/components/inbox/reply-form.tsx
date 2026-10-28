"use client";

import { useId, useRef, useState, useTransition } from "react";

import { AttachButton, UploadList, useUploads } from "@/components/attachment-uploads";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { replyInConversation, uploadReplyAttachment } from "@/server/inbox";

type Kind = "reply" | "note";

/**
 * The team's reply box, or a note only the team sees (never sent); ⌘/Ctrl+Enter sends. Each keeps its
 * own draft. Files attached upload straight to the media storage and go with what's sent.
 */
export function ReplyForm({ projectSlug, number }: { projectSlug: string; number: number }) {
  const [kind, setKind] = useState<Kind>("reply");
  const [drafts, setDrafts] = useState<Record<Kind, string>>({ reply: "", note: "" });
  const files = useUploads((file) => uploadReplyAttachment(projectSlug, file));
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const errorId = useId();
  const note = kind === "note";

  const send = () =>
    startTransition(async () => {
      const result = await replyInConversation(projectSlug, number, drafts[kind], note, files.ids);
      setError(result.error);
      if (!result.error) {
        setDrafts((current) => ({ ...current, [kind]: "" }));
        files.clear();
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
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !pending && !files.uploading) {
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
      <UploadList uploads={files.uploads} remove={files.remove} />
      <div className="flex items-center justify-between gap-2">
        <AttachButton attach={files.attach} />
        <Button type="submit" disabled={pending || files.uploading}>
          {pending ? "Sending…" : note ? "Add note" : "Send"}
        </Button>
      </div>
    </form>
  );
}
