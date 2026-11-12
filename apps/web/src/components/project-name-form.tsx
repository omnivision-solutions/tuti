"use client";

import { useActionState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { renameProject } from "@/server/project-settings";

/** Settings → General's name row (project.update). */
export function ProjectNameForm({ projectSlug, name }: { projectSlug: string; name: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await renameProject(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Project renamed");
    }
    return result;
  }, {});
  return (
    <SettingRow label="Project name" description="Shown on your portal, in its emails and in the app." htmlFor="project-name">
      <form {...keepingFields(action)} className="flex flex-wrap items-start gap-2">
        {/* A new key once saved: the field shows the name as saved (trimmed), not as typed. Its length is
            the server's to check, after trimming (a limit here would count the spaces). */}
        <Input
          key={name}
          id="project-name"
          name="name"
          defaultValue={name}
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "project-name-description project-name-error" : "project-name-description"}
          className="min-w-0 flex-1 @min-[34rem]/settings:w-60 @min-[34rem]/settings:flex-none"
        />
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.error && (
          <FieldError id="project-name-error" className="basis-full">
            {state.error}
          </FieldError>
        )}
      </form>
    </SettingRow>
  );
}
