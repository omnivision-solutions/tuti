"use client";

import { useActionState, useId, useState } from "react";

import { keepingFields } from "@/lib/forms";
import { RichEditor } from "@/components/rich-editor";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import type { FormState } from "@/server/form-state";
import { addComment } from "@/server/posts";

/**
 * `notes`: the team's form, which can write an internal note (only the team sees it) instead, or email the
 * reply to the post's `voters` (how many it would email).
 */
export function CommentForm({ postId, placeholder = "Add a comment…", notes = false, voters = 0 }: { postId: string; placeholder?: string; notes?: boolean; voters?: number }) {
  const [internal, setInternal] = useState(false);
  const [emailVoters, setEmailVoters] = useState(false);
  // Bumped after each comment, to start the next one with an empty editor.
  const [submitted, setSubmitted] = useState(0);
  const errorId = useId();
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await addComment(prev, formData);
    if (!result.error) {
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
