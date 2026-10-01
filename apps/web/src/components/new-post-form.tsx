"use client";

import { useActionState, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/server/form-state";
import { createPost } from "@/server/posts";

export function NewPostForm({ projectSlug, boardSlug }: { projectSlug: string; boardSlug: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(createPost, {});

  useEffect(() => {
    if (!pending && !state.error) {
      formRef.current?.reset();
    }
  }, [pending, state]);

  return (
    <Card>
      <CardContent>
        <form ref={formRef} action={action}>
          <input type="hidden" name="projectSlug" value={projectSlug} />
          <input type="hidden" name="boardSlug" value={boardSlug} />
          <FieldGroup>
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor="post-title">Title</FieldLabel>
              <Input
                id="post-title"
                name="title"
                placeholder="Short, descriptive title"
                required
                aria-invalid={state.error ? true : undefined}
              />
              {state.error && <FieldError>{state.error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="post-body">Details</FieldLabel>
              <Textarea id="post-body" name="body" placeholder="Any more details?" rows={3} />
            </Field>
            <Button type="submit" disabled={pending} className="self-end">
              {pending ? "Posting…" : "Submit feedback"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
