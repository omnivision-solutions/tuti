"use client";

import type { Doc } from "@tuti/content";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/react";
import { useActionState, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { keepingFields } from "@/lib/forms";
import { RichEditor } from "@/components/rich-editor";
import { useSignInHref } from "@/components/sign-in-link";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import type { FormState } from "@/server/form-state";
import { addComment } from "@/server/posts";

const noSubscription = () => () => {};

/** How long a comment written signed out waits for its sender (a shared browser's next user isn't handed it after that). */
const DRAFT_MS = 60 * 60 * 1000;

/** A comment written signed out, kept in this browser till it's sent (storage can be off: then nothing). */
const drafts = {
  /** The saved draft as stored (the same string each time: a snapshot), or null. */
  read(key: string): string | null {
    try {
      const json = window.localStorage.getItem(key);
      return json && Date.now() - (JSON.parse(json) as { savedAt: number }).savedAt < DRAFT_MS ? json : null;
    } catch {
      return null;
    }
  },
  save(key: string, doc: Doc | null) {
    try {
      if (doc) {
        window.localStorage.setItem(key, JSON.stringify({ doc, savedAt: Date.now() }));
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {}
  },
};

/**
 * `notes`: the team's form, which can write an internal note (only the team sees it) instead, or email the
 * reply to the post's `voters` (how many it would email).
 *
 * Signed out (`signedIn` false), sending goes to sign in instead, coming back here; what was written
 * waits in this browser (localStorage, for an hour) and is in the box again on the way back, until it's
 * sent or emptied.
 */
export function CommentForm({
  postId,
  placeholder = "Add a comment…",
  notes = false,
  voters = 0,
  signedIn = true,
}: {
  postId: string;
  placeholder?: string;
  notes?: boolean;
  voters?: number;
  signedIn?: boolean;
}) {
  const router = useRouter();
  const signInHref = useSignInHref();
  const draftKey = `tuti:comment-draft:${postId}`;
  // None on the server and in the first render (hydration), then this browser's draft, if any.
  const draftJson = useSyncExternalStore(noSubscription, () => drafts.read(draftKey), () => null);
  const draft = useMemo(() => (draftJson ? (JSON.parse(draftJson) as { doc: Doc }).doc : undefined), [draftJson]);
  const editor = useRef<Editor | null>(null);
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
    if (!signedIn) {
      const content = formData.get("content");
      drafts.save(draftKey, typeof content === "string" && content ? (JSON.parse(content) as Doc) : null);
      router.push(signInHref);
      return prev;
    }
    const result = await addComment(prev, formData);
    if (!result.error) {
      drafts.save(draftKey, null);
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
          // A new editor once the draft is read (the editor takes its content when it's made).
          key={draft ? "draft" : submitted}
          initial={draft}
          editorRef={editor}
          // A draft brought back keeps up with the box: changed, or emptied to throw it away.
          onChange={() => draft && editor.current && drafts.save(draftKey, editor.current.isEmpty ? null : editor.current.getJSON())}
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
        {!signedIn && <p className="mr-auto text-sm text-muted-foreground">You&apos;ll sign in to post it; what you wrote is kept.</p>}
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
