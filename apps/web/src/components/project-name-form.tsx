"use client";

import { useActionState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { renameProject } from "@/server/project-settings";

/** Settings → General's name field (project.update). */
export function ProjectNameForm({ projectSlug, name }: { projectSlug: string; name: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await renameProject(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Project renamed");
    }
    return result;
  }, {});
  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="project-name">Project name</FieldLabel>
          {/* A new key once saved: the field shows the name as saved (trimmed), not as typed. Its length is
              the server's to check, after trimming (a limit here would count the spaces). */}
          <Input key={name} id="project-name" name="name" defaultValue={name} required aria-invalid={state.error ? true : undefined} />
          <FieldDescription>Shown on your portal, in its emails and in the app.</FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <Button type="submit" disabled={pending} className="self-end">
          {pending ? "Saving…" : "Save"}
        </Button>
      </FieldGroup>
    </form>
  );
}
