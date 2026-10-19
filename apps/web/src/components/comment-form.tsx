"use client";

import { useActionState, useId, useState } from "react";

import { keepingFields } from "@/lib/forms";
import { RichEditor } from "@/components/rich-editor";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import type { FormState } from "@/server/form-state";
import { addComment } from "@/server/posts";

export function CommentForm({ postId, placeholder = "Add a comment…" }: { postId: string; placeholder?: string }) {
  // Bumped after each comment, to start the next one with an empty editor.
  const [submitted, setSubmitted] = useState(0);
  const errorId = useId();
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await addComment(prev, formData);
    if (!result.error) {
      setSubmitted((n) => n + 1);
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
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? "Posting…" : "Comment"}
      </Button>
    </form>
  );
}
