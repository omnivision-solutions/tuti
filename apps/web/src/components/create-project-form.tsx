"use client";

import { useActionState, useState } from "react";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/server/form-state";
import { createProject } from "@/server/projects";

/** `portalExample`: the portal address of a project called "acme" (PORTAL_URL_TEMPLATE), to show the one being typed. */
export function CreateProjectForm({ portalExample }: { portalExample: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createProject, {});
  const [slug, setSlug] = useState("");
  const host = new URL(portalExample).host;
  const at = host.indexOf("acme");

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
          <FieldDescription>
            {at < 0 ? (
              `Your portal will be at ${host}`
            ) : (
              <>
                Your portal will be {host.slice(0, at)}
                {slug.trim().toLowerCase() || "acme"}
                {host.slice(at + "acme".length)}
              </>
            )}
          </FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Creating…" : "Create project"}
        </Button>
      </FieldGroup>
    </form>
  );
}
