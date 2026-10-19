"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { disconnectGithub, setGithubCloseOn } from "@/server/github";

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

const CLOSE_ON = {
  RELEASE: "a release ships their pull request",
  MERGE: "their pull request is merged",
} as const;

export function CloseOnSelect({ projectSlug, closeOn }: { projectSlug: string; closeOn: keyof typeof CLOSE_ON }) {
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex flex-wrap items-center gap-2">
      Linked posts become Completed when
      <Select
        items={CLOSE_ON}
        value={closeOn}
        disabled={pending}
        onValueChange={(value) =>
          startTransition(async () => {
            const result = await setGithubCloseOn(projectSlug, String(value));
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success("Saved");
            }
          })
        }
      >
        <SelectTrigger className="w-full sm:w-72" aria-label="When linked posts become Completed">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(CLOSE_ON) as (keyof typeof CLOSE_ON)[]).map((value) => (
            <SelectItem key={value} value={value}>
              {CLOSE_ON[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
