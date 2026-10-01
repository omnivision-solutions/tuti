"use client";

import { useActionState, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/server/form-state";
import { addComment } from "@/server/posts";

export function CommentForm({ postId, placeholder = "Add a comment…" }: { postId: string; placeholder?: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await addComment(prev, formData);
    if (!result.error) {
      formRef.current?.reset();
    }
    return result;
  }, {});

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="postId" value={postId} />
      <Field data-invalid={state.error ? true : undefined}>
        <Textarea
          name="body"
          rows={3}
          placeholder={placeholder}
          aria-label="Comment"
          required
          aria-invalid={state.error ? true : undefined}
        />
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? "Posting…" : "Comment"}
      </Button>
    </form>
  );
}
