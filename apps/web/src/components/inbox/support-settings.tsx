"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { setSupportInbox } from "@/server/inbox";

/** Turns the support inbox on or off. */
export function SupportInboxSwitch({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(on);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor="support-inbox" className="text-sm font-medium">
          Messages in the widget
        </label>
        <p className="text-sm text-muted-foreground">
          Your users get a Messages tab in the widget to write to your team and see your replies there. Signed out, they leave their email first.
        </p>
      </div>
      <Switch
        id="support-inbox"
        className="mt-0.5"
        checked={checked}
        disabled={pending}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setChecked(next);
          startTransition(async () => {
            const result = await setSupportInbox(projectSlug, next);
            if (result.error) {
              setChecked(!next);
              toast.error(result.error);
            } else {
              toast.success(next ? "Messages on" : "Messages off");
            }
          });
        }}
      />
    </div>
  );
}
