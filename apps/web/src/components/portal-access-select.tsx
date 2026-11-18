"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
import type { PortalAccess } from "@/server/operations/portal";
import { setPortalAccess } from "@/server/portal-settings";

const ACCESS: Record<PortalAccess, string> = {
  public: "Public",
  private: "Private",
};

const DESCRIPTIONS: Record<PortalAccess, string> = {
  public: "Anyone can read it, and sign up to post and vote.",
  private:
    "Only your team, people your app signs in with single sign-on, and the readers you add below. Everyone else gets the sign-in page; sign-up is off and search engines are kept out.",
};

/** `upgrade`: the plan has no private portal, so choosing Private opens the upgrade prompt and the portal stays as it is. */
export function PortalAccessSelect({ projectSlug, access, upgrade }: { projectSlug: string; access: PortalAccess; upgrade?: UpgradePrompt }) {
  const [pending, startTransition] = useTransition();
  const [upgrading, setUpgrading] = useState(false);
  const needsId = useId();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <Select
        items={ACCESS}
        value={access}
        disabled={pending}
        onValueChange={(value) => {
          if (upgrade && value === "private") {
            setUpgrading(true);
            return;
          }
          startTransition(async () => {
            const result = await setPortalAccess(projectSlug, String(value));
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success(value === "private" ? "Portal is now private" : "Portal is now public");
            }
          });
        }}
      >
        <SelectTrigger className="w-full sm:w-48" aria-label="Portal access">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ACCESS) as PortalAccess[]).map((value) => (
            <SelectItem key={value} value={value} aria-describedby={upgrade && value === "private" ? needsId : undefined}>
              {ACCESS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {upgrade && (
        <>
          <span id={needsId} hidden>
            {upgrade.title}
          </span>
          <UpgradeDialog prompt={upgrade} open={upgrading} onOpenChange={setUpgrading} />
        </>
      )}
      <p className="text-muted-foreground">{DESCRIPTIONS[access]}</p>
    </div>
  );
}
