"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { usePreview } from "@/components/customize-shell";
import { SettingRow } from "@/components/settings-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PortalHomePage } from "@/server/operations/portal";
import { setPortalHome } from "@/server/portal-settings";

const HOMES: Record<PortalHomePage, string> = {
  feedback: "Feedback",
  roadmap: "Roadmap",
  changelog: "Changelog",
  docs: "Documentation",
};

/** Settings → Portal → Navigation → Home page (see portal.update's `home`): what the portal's address opens, saved as it's picked. */
export function PortalHomeSelect({ projectSlug, home }: { projectSlug: string; home: PortalHomePage }) {
  const [pending, startTransition] = useTransition();
  const preview = usePreview();
  return (
    <SettingRow label={<span id="portal-home-label">Home page</span>} inline>
      <Select
        items={HOMES}
        value={home}
        // Read-only while it saves, not disabled: the focus stays on it.
        readOnly={pending}
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
        <SelectTrigger className="w-32 @min-[20rem]/settings:w-40" aria-labelledby="portal-home-label">
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
    </SettingRow>
  );
}
