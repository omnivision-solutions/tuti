"use client";

import { FileTextIcon, SparklesIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, useTransition } from "react";

import { AttachButton, type Upload, UploadList, useUploads } from "@/components/attachment-uploads";
import { InsertArticleDialog, type InsertableArticle } from "@/components/inbox/insert-article";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { draftReplyWithAi, replyInConversation, uploadReplyAttachment } from "@/server/inbox";

type Kind = "reply" | "note";

/**
 * What's written in each conversation's reply and note, the files attached that had uploaded (and the names of those
 * still uploading, which aren't kept), and what the team had seen as the reply was started: kept in the tab as another
 * conversation opens beside the list. By who's signed in: someone signing in after them in the same tab doesn't get them.
 */
const kept = new Map<string, { drafts: Record<Kind, string>; files: Upload[]; unfinished: string[]; seen?: string }>();

/**
 * The team's reply box, or a note only the team sees (never sent); ⌘/Ctrl+Enter sends. Each keeps its
 * own draft, there again when the conversation is (with its files). Files attached upload straight to the media
 * storage and go with what's sent. "Insert article" (⌘/Ctrl+K in the reply) puts a link to a help article where the cursor is.
 */
export function ReplyForm({
  projectSlug,
  number,
  userId,
  filesLastFor,
  draftWithAi = "off",
  articles = false,
  seen,
}: {
  projectSlug: string;
  /** Who's signed in: their drafts are theirs. */
  userId: string;
  /** How long a file attached can still be sent (ms): unsent, the server deletes it after a while. */
  filesLastFor: number;
  number: number;
  /** When the latest message on the page was written (ISO): the user writing after it keeps the conversation open. */
  seen?: string;
  /** "Draft with AI": shown when the server has AI and docs search ("on"), disabled while the project is out of AI credits ("paused"). */
  draftWithAi?: "on" | "paused" | "off";
  /** "Insert article": shown when the project has published articles a link can go to. */
  articles?: boolean;
}) {
  const [kind, setKind] = useState<Kind>("reply");
  // The tab they're on now, for a draft that finishes after they've moved.
  const current = useRef<Kind>("reply");
  const key = `${userId}/${projectSlug}/${number}`;
  const [drafts, setDrafts] = useState<Record<Kind, string>>(() => kept.get(key)?.drafts ?? { reply: "", note: "" });
  // A kept draft's files, but those attached too long ago to send (the server has deleted them, or is about to), and
  // those that hadn't finished uploading: named instead, to be attached again.
  const [restored] = useState(() => {
    const files = kept.get(key)?.files ?? [];
    const now = Date.now();
    const gone = files.filter((file) => now - file.startedAt >= filesLastFor).map((file) => file.name);
    const unfinished = kept.get(key)?.unfinished ?? [];
    const again = (names: string[], why: string) => (names.length > 0 ? [`${names.join(", ")} ${why}: attach ${names.length === 1 ? "it" : "them"} again.`] : []);
    return {
      files: files.filter((file) => now - file.startedAt < filesLastFor),
      notice: [...again(gone, "attached too long ago to send"), ...again(unfinished, "didn't finish uploading")].join(" ") || undefined,
    };
  });
  const files = useUploads((file) => uploadReplyAttachment(projectSlug, file), restored.files);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const [drafting, startDrafting] = useTransition();
  const [notice, setNotice] = useState(restored.notice);
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [inserting, setInserting] = useState(false);
  // Where the cursor goes once an article's link is in: at its end.
  const caret = useRef<number>(undefined);
  useLayoutEffect(() => {
    if (caret.current !== undefined) {
      textarea.current?.setSelectionRange(caret.current, caret.current);
      caret.current = undefined;
    }
  }, [drafts]);
  const errorId = useId();
  const note = kind === "note";
  // What the team saw as they started this reply: held while it's being written or has files attached (a message arriving
  // meanwhile, which the page's live refresh shows above, may go unread), the page's latest again once the box is empty
  // (a file that couldn't upload, left in the list, isn't going anywhere: it doesn't hold it).
  // A reply kept from before another conversation opened holds what was seen as it was started.
  const [replySeen, setReplySeen] = useState(() => {
    const draft = kept.get(key);
    return draft && (draft.drafts.reply || draft.files.length > 0 || draft.unfinished.length > 0) ? draft.seen : seen;
  });
  if (!drafts.reply && files.uploads.every((upload) => upload.error) && replySeen !== seen) {
    setReplySeen(seen);
  }
  useEffect(() => {
    kept.set(key, {
      drafts,
      files: files.uploads.filter((upload) => upload.id),
      unfinished: files.uploads.filter((upload) => !upload.id && !upload.error).map((upload) => upload.name),
      seen: replySeen,
    });
  }, [key, drafts, files.uploads, replySeen]);

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

  // The article's title and its address on the portal, as AI drafts cite them, in place of what's selected in the reply
  // (or at the cursor), a space either side where it would run into the words around it.
  const insert = (article: InsertableArticle) => {
    const text = drafts.reply;
    const before = text.slice(0, textarea.current?.selectionStart ?? text.length);
    const after = text.slice(textarea.current?.selectionEnd ?? text.length);
    const link = `${before && !/\s$/.test(before) ? " " : ""}${article.title}: ${article.url}`;
    caret.current = before.length + link.length;
    setDrafts((drafts) => ({ ...drafts, reply: `${before}${link}${after && !/^\s/.test(after) ? " " : ""}${after}` }));
  };

  const send = (close = false) =>
    startTransition(async () => {
      const sending = kind;
      const text = drafts[sending];
      const attached = files.ids;
      const result = await replyInConversation(projectSlug, number, text, sending === "note", attached, close && sending === "reply", replySeen);
      setError(result.error);
      setNotice(result.notice);
      if (!result.error) {
        // Only what was sent: anything added meanwhile stays. (Still here: a row opened meanwhile waits for the reply.)
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
          ref={textarea}
          aria-label={note ? "Note" : "Reply"}
          placeholder={note ? "Write a note only your team sees…" : "Write a reply…"}
          value={drafts[kind]}
          onChange={(event) => setDrafts((current) => ({ ...current, [kind]: event.target.value }))}
          onKeyDown={(event) => {
            // As in the docs editor, ⌘/Ctrl+K puts in a link (⌘K's search stays shut).
            if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !note && articles && !pending) {
              event.preventDefault();
              setInserting(true);
            }
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
          {!note && articles && (
            <>
              <Button type="button" variant="ghost" size="sm" disabled={pending} title="Insert article (⌘K)" onClick={() => setInserting(true)}>
                <FileTextIcon />
                Insert article
              </Button>
              <InsertArticleDialog projectSlug={projectSlug} number={number} open={inserting} onOpenChange={setInserting} onPick={insert} finalFocus={textarea} />
            </>
          )}
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
