"use client";

import { SparklesIcon } from "lucide-react";
import { useId, useRef, useState, useTransition } from "react";

import { AttachButton, UploadList, useUploads } from "@/components/attachment-uploads";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { draftReplyWithAi, replyInConversation, uploadReplyAttachment } from "@/server/inbox";

type Kind = "reply" | "note";

/**
 * The team's reply box, or a note only the team sees (never sent); ⌘/Ctrl+Enter sends. Each keeps its
 * own draft. Files attached upload straight to the media storage and go with what's sent.
 */
export function ReplyForm({
  projectSlug,
  number,
  draftWithAi = "off",
  seen,
}: {
  projectSlug: string;
  number: number;
  /** When the latest message on the page was written (ISO): the user writing after it keeps the conversation open. */
  seen?: string;
  /** "Draft with AI": shown when the server has AI and docs search ("on"), disabled while the project is out of AI credits ("paused"). */
  draftWithAi?: "on" | "paused" | "off";
}) {
  const [kind, setKind] = useState<Kind>("reply");
  // The tab they're on now, for a draft that finishes after they've moved.
  const current = useRef<Kind>("reply");
  const [drafts, setDrafts] = useState<Record<Kind, string>>({ reply: "", note: "" });
  const files = useUploads((file) => uploadReplyAttachment(projectSlug, file));
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const [drafting, startDrafting] = useTransition();
  const [notice, setNotice] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const errorId = useId();
  const note = kind === "note";

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
        // Into the reply's draft, whichever tab they're on now: they choose what to send (and hear where it went).
        const text = result.draft;
        setDrafts((drafts) => ({ ...drafts, reply: drafts.reply.trim() ? `${drafts.reply.trimEnd()}\n\n${text}` : text }));
        if (current.current !== "reply") {
          setNotice("Your draft is ready in the Reply tab");
        }
      }
    });

  const send = (close = false) =>
    startTransition(async () => {
      const sending = kind;
      const text = drafts[sending];
      const attached = files.ids;
      const result = await replyInConversation(projectSlug, number, text, sending === "note", attached, close && sending === "reply", seen);
      setError(result.error);
      if (!result.error) {
        // Only what was sent: anything added meanwhile stays.
        setDrafts((current) => ({ ...current, [sending]: current[sending] === text ? "" : current[sending] }));
        files.sent(attached);
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
          current.current = value as Kind;
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
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !pending && !drafting && !files.uploading) {
              event.preventDefault();
              form.current?.requestSubmit();
            }
          }}
          rows={4}
          // While it's sending, what's there is what's sent: nothing to add that the send would then clear or repeat.
          readOnly={pending}
          className={note ? "border-dashed bg-highlight/40" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Field>
      <UploadList uploads={files.uploads} remove={files.remove} />
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      {/* On a phone, the send buttons go to a row of their own (on the right) rather than past the screen's edge. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <AttachButton attach={files.attach} />
          {draftWithAi !== "off" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={drafting || pending || draftWithAi === "paused"}
              title={draftWithAi === "paused" ? "This project is out of AI credits" : undefined}
              onClick={draft}
            >
              <SparklesIcon />
              {drafting ? "Drafting…" : "Draft with AI"}
            </Button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Answered, and done with: closed with the reply (not left waiting on them). */}
          {!note && (
            <Button type="button" variant="outline" disabled={pending || drafting || files.uploading} onClick={() => send(true)}>
              Send and close
            </Button>
          )}
          <Button type="submit" disabled={pending || drafting || files.uploading}>
            {pending ? "Sending…" : note ? "Add note" : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}
