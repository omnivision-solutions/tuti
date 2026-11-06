"use client";

import { type Doc, readableBy } from "@tuti/content";
import { useRouter } from "next/navigation";
import { useActionState, useId, useRef, useState } from "react";

import { votersNote } from "@/lib/format";
import { keepingFields } from "@/lib/forms";
import { type EditorUploads, RichEditor } from "@/components/rich-editor";
import { useSignInHref } from "@/components/sign-in-link";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
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
 * `signedIn`: the portal's public box (the team's forms leave it out). What's written in it is kept in
 * this tab till it's sent or emptied, and is back in the box when it opens again in this tab: signed out,
 * sending goes to sign in instead, coming back here to send it.
 *
 * `uploads`: images can be added (pasted, dropped or picked), as in a post; without it (signed out, or no media
 * storage), text only.
 */
export function CommentForm({
  postId,
  placeholder = "Add a comment…",
  notes = false,
  voters = 0,
  signedIn,
  uploads,
}: {
  postId: string;
  placeholder?: string;
  notes?: boolean;
  voters?: number | "paused";
  signedIn?: boolean;
  uploads?: EditorUploads;
}) {
  const router = useRouter();
  const signInHref = useSignInHref();
  const portal = signedIn !== undefined;
  const draftKey = `tuti:comment-draft:${postId}`;
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
    if (signedIn === false) {
      router.push(signInHref);
      return prev;
    }
    const result = await addComment(prev, formData);
    if (!result.error) {
      if (portal) {
        drafts.save(draftKey, null);
      }
      setSubmitted((n) => n + 1);
      // The next one is a reply again, emailing nobody, unless switched on again.
      setInternal(false);
      setEmailVoters(false);
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)} className="flex flex-col gap-2">
      <input type="hidden" name="postId" value={postId} />
      <Field data-invalid={state.error ? true : undefined}>
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
            drafts.save(draftKey, editor.isEmpty ? null : editor.getJSON());
          }}
          profile="comment"
          uploads={uploads}
          name="content"
          label="Comment"
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
        {signedIn === false && <p className="mr-auto text-sm text-muted-foreground">You&apos;ll sign in to post it.</p>}
        {notes && (
          <div className="mr-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Switch name="internal" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
              Internal note <span className="text-muted-foreground">(only your team sees it)</span>
            </label>
            {/* A note is never emailed. */}
            {!internal && (
              <label className="flex items-center gap-2">
                <Switch
                  name="emailVoters"
                  checked={emailVoters}
                  disabled={voters === 0 || voters === "paused"}
                  onChange={(event) => setEmailVoters(event.target.checked)}
                />
                Email voters <span className="text-muted-foreground">({votersNote(voters)})</span>
              </label>
            )}
          </div>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Posting…" : internal ? "Add note" : emailVoters ? "Comment and email" : "Comment"}
        </Button>
      </div>
    </form>
  );
}
