"use client";

import { useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { continueToPortal } from "@/server/portal-handoff";

export function ContinueToPortalButton({
  projectSlug,
  state,
  redirectPath,
  name,
}: {
  projectSlug: string;
  state: string;
  redirectPath: string;
  name: string;
}) {
  const [pending, startTransition] = useTransition();
  // Disabled until hydrated: a click before then would do nothing.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  return (
    <Button
      disabled={pending || !hydrated}
      onClick={() =>
        startTransition(async () => {
          const result = await continueToPortal(projectSlug, state, redirectPath);
          if (result?.error) {
            toast.error(result.error);
          }
        })
      }
    >
      Continue as {name}
    </Button>
  );
}
