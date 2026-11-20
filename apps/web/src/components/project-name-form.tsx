"use client";

import { useLayoutEffect, useRef } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { SettingRow } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { renameProject } from "@/server/project-settings";

/** Settings → General's name row (project.update), saved by the page's "Save changes". */
export function ProjectNameForm({ projectSlug, name }: { projectSlug: string; name: string }) {
  // Renamed elsewhere meanwhile (another tab), the field follows where it isn't edited here (before the form compares
  // with what's saved, in useCustomizeForm's effect). Not to this tab's own save: what's typed since stays.
  const field = useRef<HTMLInputElement>(null);
  const nameWas = useRef(name);
  const sent = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (field.current?.value === nameWas.current && name !== sent.current) {
      field.current.value = name;
    }
    nameWas.current = name;
  }, [name]);
  const { state, form } = useCustomizeForm({
    saved: [["name", name]],
    save: async (prev, formData) => {
      sent.current = String(formData.get("name"));
      const result = await renameProject(projectSlug, prev, formData);
      if (!result.error) {
        toast.success("Project renamed");
      }
      return result;
    },
  });
  return (
    <SettingRow label="Project name" htmlFor="project-name">
      <form {...form} className="flex flex-wrap items-start gap-2">
        {/* The form trims it as it's sent, so the field shows the name as saved; no new key once saved, which would drop
            what's typed while it saves. Its length is the server's to check, after trimming (a limit here would count
            the spaces). */}
        <Input
          ref={field}
          id="project-name"
          name="name"
          defaultValue={name}
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "project-name-error" : undefined}
          className="min-w-0 flex-1 @min-[34rem]/settings:w-60 @min-[34rem]/settings:flex-none"
        />
        {state.error && (
          <FieldError id="project-name-error" className="basis-full">
            {state.error}
          </FieldError>
        )}
      </form>
    </SettingRow>
  );
}
