"use client";

import type { Doc } from "@tuti/content";
import { useRouter } from "next/navigation";
import { useActionState, useId, useState } from "react";

import { keepingFields } from "@/lib/forms";
import { RichEditor } from "@/components/rich-editor";
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
 * reply to the post's `voters` (how many it would email).
 *
 * `signedIn`: the portal's public box (the team's forms leave it out). What's written in it is kept in
 * this tab till it's sent or emptied, and is back in the box when it opens again in this tab: signed out,
 * sending goes to sign in instead, coming back here to send it.
 */
export function CommentForm({
  postId,
  placeholder = "Add a comment…",
  notes = false,
  voters = 0,
  signedIn,
}: {
  postId: string;
  placeholder?: string;
  notes?: boolean;
  voters?: number;
  signedIn?: boolean;
}) {
  const router = useRouter();
  const signInHref = useSignInHref();
  const portal = signedIn !== undefined;
  const draftKey = `tuti:comment-draft:${postId}`;
  const [internal, setInternal] = useState(false);
  const [emailVoters, setEmailVoters] = useState(false);
  // Bumped after each comment, to start the next one with an empty editor.
  const [submitted, setSubmitted] = useState(0);
  const errorId = useId();
  // Off once nobody's left to email (after a refresh): a disabled switch isn't sent, and a voter
  // coming back later doesn't switch it on again.
  if (emailVoters && voters === 0) {
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
            if (draft) {
              editor.commands.setContent(draft, { emitUpdate: true });
            }
          }}
          onChange={(editor) => portal && drafts.save(draftKey, editor.isEmpty ? null : editor.getJSON())}
          profile="comment"
          name="content"
          label="Comment"
          placeholder={placeholder}
          invalid={!!state.error}
          describedBy={errorId}
        />
        {state.error && <FieldError id={errorId}>{state.error}</FieldError>}
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
                <Switch name="emailVoters" checked={emailVoters} disabled={voters === 0} onChange={(event) => setEmailVoters(event.target.checked)} />
                Email voters <span className="text-muted-foreground">({voters === 0 ? "nobody to email" : voters === 1 ? "1 person" : `${voters} people`})</span>
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
