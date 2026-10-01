"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/server/form-state";
import { createWorkspace } from "@/server/workspaces";

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createWorkspace, {});

  return (
    <form action={action}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
          <Input id="workspace-name" name="name" placeholder="Acme" required />
        </Field>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="workspace-slug">URL</FieldLabel>
          <Input id="workspace-slug" name="slug" placeholder="acme" required aria-invalid={state.error ? true : undefined} />
          <FieldDescription>Your board will live at tuti.so/&lt;url&gt;.</FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Creating…" : "Create workspace"}
        </Button>
      </FieldGroup>
    </form>
  );
}
