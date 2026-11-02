"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { PROJECT_USES, type ProjectUse } from "@/lib/project-uses";
import { addSampleContent, setProjectUses } from "@/server/projects";

/** The first run's "What will you use?": several at once, saved on the project before the next step, with sample content for them if asked. */
export function SetupUses({ projectSlug, picked, sample, next, skip }: { projectSlug: string; picked: string[]; sample: boolean; next: string; skip: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const uses = form.getAll("uses").map(String);
        startTransition(async () => {
          const result = await setProjectUses(projectSlug, uses);
          const added = !result.error && form.has("sample") ? await addSampleContent(projectSlug) : {};
          if (result.error || added.error) {
            toast.error(result.error ?? added.error);
            return;
          }
          router.push(next);
        });
      }}
    >
      <CardContent role="group" aria-label="What will you use? Pick any" className="grid gap-3 sm:grid-cols-2">
        {(Object.entries(PROJECT_USES) as [ProjectUse, (typeof PROJECT_USES)[ProjectUse]][]).map(([key, use]) => (
          <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-soft">
            <input type="checkbox" name="uses" value={key} defaultChecked={picked.includes(key)} className="mt-0.5 size-4 accent-primary" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{use.label}</span>
              <span className="text-sm text-muted-foreground">{use.description}</span>
            </span>
          </label>
        ))}
      </CardContent>
      {!sample && (
        <CardContent>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" name="sample" className="mt-0.5 size-4 accent-primary" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Add sample content to try things with</span>
              <span className="text-sm text-muted-foreground">For what you pick, labelled Sample. Remove it from Home when you&apos;re done.</span>
            </span>
          </label>
        </CardContent>
      )}
      <CardFooter className="justify-end gap-2">
        {skip}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Continue"}
        </Button>
      </CardFooter>
    </form>
  );
}
