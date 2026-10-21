"use client";

import { useActionState, useState } from "react";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/server/form-state";
import { createProject } from "@/server/projects";

/** `portalTemplate`: PORTAL_URL_TEMPLATE (e.g. https://{project}.tuti.so), to show the address being typed. */
export function CreateProjectForm({ portalTemplate }: { portalTemplate: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createProject, {});
  const [slug, setSlug] = useState("");
  // The address as people see it: no scheme, no trailing slash.
  const address = portalTemplate.replace("{project}", slug.trim().toLowerCase() || "acme").replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");

  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-name">Name</FieldLabel>
          <Input id="project-name" name="name" placeholder="Acme" required />
        </Field>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="project-slug">URL</FieldLabel>
          <Input
            id="project-slug"
            name="slug"
            placeholder="acme"
            required
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            aria-invalid={state.error ? true : undefined}
          />
          <FieldDescription>Your portal will be {address}</FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Creating…" : "Create project"}
        </Button>
      </FieldGroup>
    </form>
  );
}
