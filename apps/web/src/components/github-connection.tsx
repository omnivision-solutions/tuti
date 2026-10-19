"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { disconnectGithub } from "@/server/github";

export function DisconnectGithubButton({ projectSlug }: { projectSlug: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await disconnectGithub(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("GitHub disconnected");
          }
        })
      }
    >
      Disconnect
    </Button>
  );
}
