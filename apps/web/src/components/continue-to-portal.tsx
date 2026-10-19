"use client";

import { useTransition } from "react";
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
  return (
    <Button
      disabled={pending}
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
