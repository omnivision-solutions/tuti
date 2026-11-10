"use client";

import { type Doc, isEmptyDoc, readableBy } from "@tuti/content";
import { useActionState, useId, useRef, useState } from "react";

import { votersNote } from "@/lib/format";
import { keepingFields } from "@/lib/forms";
import { type EditorUploads, RichEditor } from "@/components/rich-editor";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FormState } from "@/server/form-state";
import { addComment } from "@/server/posts";

/** What's written in a post's portal box, kept in this tab (sessionStorage) till it's sent or emptied; storage off: nothing. */
const drafts = {
  take(key: string): Doc | null {
    try {
      return JSON.parse(window.sessionStorage.getItem(key) ?? "null") as Doc | null;
    } catch {
      return null;
    }
  },
  save(key: string, doc: Doc | null) {
    try {
      if (doc) {
        window.sessionStorage.setItem(key, JSON.stringify(doc));
      } else {
        window.sessionStorage.removeItem(key);
      }
    } catch {}
  },
};

/**
 * `notes`: the team's form, which can write an internal note (only the team sees it) instead, or email the
 * reply to the post's `voters` (how many it would email; "paused" while the project's email is).
 *
 * `signedIn`: the portal's box (the team's forms leave it out; signed out, the portal shows a bar to sign in instead).
 * What's written in it is kept in this tab till it's sent or emptied, and is back in the box when it opens again in this tab.
 *
 * `uploads`: images can be added (pasted, dropped or picked), as in a post; without it (signed out, or no media
 * storage), text only.
 *
 * `replyTo`: a reply to that comment (its box opened by Reply, focused, `onDone` once posted, with Cancel: `onCancel`).
 */
export function CommentForm({
  postId,
  placeholder = "Add a comment…",
  notes = false,
  voters = 0,
  signedIn,
  uploads,
  replyTo,
  autoFocus,
  onDone,
  onCancel,
}: {
  postId: string;
  replyTo?: string;
  autoFocus?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  notes?: boolean;
  voters?: number | "paused";
  signedIn?: boolean;
  uploads?: EditorUploads;
}) {
  const portal = signedIn !== undefined;
  const draftKey = `tuti:comment-draft:${postId}${replyTo ? `:${replyTo}` : ""}`;
  // The draft in storage couldn't be read here (onCreate below): it isn't saved over while this page is open.
  // A stored draft this page can't read: kept as it is until a new comment is written here (then that's the draft).
  const draftUnreadable = useRef(false);
  const [draftKept, setDraftKept] = useState(false);
  const keptNoteId = useId();
  const [internal, setInternal] = useState(false);
  const [emailVoters, setEmailVoters] = useState(false);
  // Bumped after each comment, to start the next one with an empty editor.
  const [submitted, setSubmitted] = useState(0);
  const errorId = useId();
  // Off once nobody's left to email (after a refresh): a disabled switch isn't sent, and a voter
  // coming back later doesn't switch it on again.
  if (emailVoters && (voters === 0 || voters === "paused")) {
    setEmailVoters(false);
  }
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await addComment(prev, formData);
    if (!result.error) {
      if (portal) {
        drafts.save(draftKey, null);
      }
      setSubmitted((n) => n + 1);
      // The next one is a reply again, emailing nobody, unless switched on again.
      setInternal(false);
      setEmailVoters(false);
      onDone?.();
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)} className="flex flex-col gap-2">
      <input type="hidden" name="postId" value={postId} />
      {replyTo && <input type="hidden" name="replyTo" value={replyTo} />}
      {/* The team's form: a reply (to everyone who sees the post) or an internal note, picked above the box. */}
      {notes && (
        <>
          {internal && <input type="hidden" name="internal" value="on" />}
          <Tabs value={internal ? "note" : "reply"} onValueChange={(value) => setInternal(value === "note")}>
            <TabsList aria-label="Write">
              <TabsTrigger value="reply">Reply</TabsTrigger>
              <TabsTrigger value="note">Internal note</TabsTrigger>
            </TabsList>
          </Tabs>
        </>
      )}
      <Field data-invalid={state.error ? true : undefined} className={cn(internal && "rounded-lg bg-highlight/25")}>
        <RichEditor
          key={submitted}
          // The portal box's draft, read once as it's made (in the browser, so the page renders the same on both sides).
          onCreate={(editor) => {
            const draft = portal && drafts.take(draftKey);
            // A draft written by a newer release (a deploy running both) that this one can't read: left in storage, as it
            // is, rather than restored without what it can't show and saved over.
            // (Set on every editor made: the form makes a new one after each comment.)
            draftUnreadable.current = !!draft && !readableBy(editor.schema, draft);
            setDraftKept(draftUnreadable.current);
            if (draft && !draftUnreadable.current) {
              editor.commands.setContent(draft, { emitUpdate: true });
            }
            if (autoFocus) {
              editor.commands.focus("end");
            }
          }}
          onChange={(editor) => {
            if (!portal) {
              return;
            }
            // Writing here starts a new comment: from then on it's the draft kept (sign-in or a reload keeps it).
            if (draftUnreadable.current) {
              if (editor.isEmpty) {
                return;
              }
              draftUnreadable.current = false;
              setDraftKept(false);
            }
            // Its words only: a restored image would have no link to show it by (they're signed as a page renders).
            // ponytail: an image added before leaving the page is gone from the draft; sign them on restore if that's missed.
            const doc = editor.getJSON() as Doc;
            const words = { ...doc, content: doc.content?.filter((node) => node.type !== "image") };
            drafts.save(draftKey, isEmptyDoc(words) ? null : words);
          }}
          profile="comment"
          uploads={uploads}
          name="content"
          label={replyTo ? "Reply" : "Comment"}
          placeholder={placeholder}
          invalid={!!state.error}
          describedBy={errorId}
          // Read with the box, before typing replaces the held draft.
          hintId={draftKept ? keptNoteId : undefined}
        />
        {state.error && <FieldError id={errorId}>{state.error}</FieldError>}
        {draftKept && (
          <p id={keptNoteId} className="text-sm text-muted-foreground">
            Your draft can&apos;t be shown here yet, likely because of an update that&apos;s just gone out. Reload the page to get it
            back; writing here starts a new comment instead.
          </p>
        )}
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {notes &&
          (internal ? (
            <p className="mr-auto text-sm text-muted-foreground">Only your team sees it.</p>
          ) : (
            // A note is never emailed.
            // At the left under the box, the button at the right.
            <label className="mr-auto flex items-center gap-2 text-sm">
              <Switch
                name="emailVoters"
                checked={emailVoters}
                disabled={voters === 0 || voters === "paused"}
                onChange={(event) => setEmailVoters(event.target.checked)}
              />
              Email voters <span className="text-muted-foreground">({votersNote(voters)})</span>
            </label>
          ))}
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Posting…" : replyTo ? "Reply" : internal ? "Add note" : emailVoters ? "Comment and email" : "Comment"}
        </Button>
      </div>
    </form>
  );
}
