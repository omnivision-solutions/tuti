"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

export function PortalAccessSelect({ projectSlug, access }: { projectSlug: string; access: PortalAccess }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <Select
        items={ACCESS}
        value={access}
        disabled={pending}
        onValueChange={(value) =>
          startTransition(async () => {
            const result = await setPortalAccess(projectSlug, String(value));
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success(value === "private" ? "Portal is now private" : "Portal is now public");
            }
          })
        }
      >
        <SelectTrigger className="w-full sm:w-48" aria-label="Portal access">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ACCESS) as PortalAccess[]).map((value) => (
            <SelectItem key={value} value={value}>
              {ACCESS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground">{DESCRIPTIONS[access]}</p>
    </div>
  );
}
