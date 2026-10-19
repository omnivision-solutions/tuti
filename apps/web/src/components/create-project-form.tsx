"use client";

import { useActionState } from "react";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/server/form-state";
import { createProject } from "@/server/projects";

export function CreateProjectForm({ portalExample }: { portalExample: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createProject, {});

  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-name">Name</FieldLabel>
          <Input id="project-name" name="name" placeholder="Acme" required />
        </Field>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="project-slug">URL</FieldLabel>
          <Input id="project-slug" name="slug" placeholder="acme" required aria-invalid={state.error ? true : undefined} />
          <FieldDescription>Your public portal, e.g. {new URL(portalExample).host}. Lowercase letters, numbers and single dashes.</FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Creating…" : "Create project"}
        </Button>
      </FieldGroup>
    </form>
  );
}
