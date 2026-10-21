"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { usePreview } from "@/components/customize-shell";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PortalHomePage } from "@/server/operations/portal";
import { setPortalHome } from "@/server/portal-settings";

const HOMES: Record<PortalHomePage, string> = {
  feedback: "Feedback",
  roadmap: "Roadmap",
  changelog: "Changelog",
  docs: "Docs",
};

const DESCRIPTIONS: Record<PortalHomePage, string> = {
  feedback: "Your first board.",
  roadmap: "What's planned, in progress and done.",
  changelog: "What you've shipped.",
  docs: "Your articles, for a portal that's mostly docs.",
};

/** Customize → Home page (see portal.update's `home`): what the portal's address opens. */
export function PortalHomeSelect({ projectSlug, home }: { projectSlug: string; home: PortalHomePage }) {
  const [pending, startTransition] = useTransition();
  const preview = usePreview();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <Select
        items={HOMES}
        value={home}
        disabled={pending}
        onValueChange={(value) =>
          startTransition(async () => {
            const result = await setPortalHome(projectSlug, String(value));
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success(`Your portal opens with ${HOMES[value as PortalHomePage].toLowerCase()} now`);
              preview.reload();
            }
          })
        }
      >
        <SelectTrigger className="w-full sm:w-48" aria-label="Home page">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(HOMES) as PortalHomePage[]).map((value) => (
            <SelectItem key={value} value={value}>
              {HOMES[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground">{DESCRIPTIONS[home]}</p>
    </div>
  );
}
