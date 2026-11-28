"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { SettingRow } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage, useTRPCClient } from "@/components/trpc";

/** Settings → General's name row (project.update), saved by the page's "Save changes". */
export function ProjectNameForm({ projectSlug, name }: { projectSlug: string; name: string }) {
  const trpc = useTRPCClient();
  const router = useRouter();
  // Renamed elsewhere meanwhile (another tab), the field follows where it isn't edited here (before the form compares
  // with what's saved, in useCustomizeForm's effect). Not to this tab's own save (the next name to come in): what's
  // typed while it ran stays.
  const field = useRef<HTMLInputElement>(null);
  const nameWas = useRef(name);
  const sent = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (field.current?.value === nameWas.current && name !== sent.current) {
      field.current.value = name;
    }
    nameWas.current = name;
    sent.current = null;
  }, [name]);
  const { state, form } = useCustomizeForm({
    saved: [["name", name]],
    save: async (_prev, formData) => {
      sent.current = String(formData.get("name"));
      try {
        await trpc.project.update.mutate({ project: projectSlug, name: sent.current });
      } catch (error) {
        return { error: errorMessage(error) };
      }
      toast.success("Project renamed");
      // The name is in the sidebar's project switcher too.
      router.refresh();
      return {};
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
