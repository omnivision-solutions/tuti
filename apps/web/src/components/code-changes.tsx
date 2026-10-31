"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { analyseCodeChange, resumeCodeChanges } from "@/server/code-changes";

/** "Analyse anyway" (nothing to do), "Analyse again" (failed) or "Resume" (paused, out of AI credits). */
export function AnalyseCodeChangeButton({ projectSlug, codeChangeId, label }: { projectSlug: string; codeChangeId: string; label: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await analyseCodeChange(projectSlug, codeChangeId);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Analysed");
          }
        })
      }
    >
      {pending ? "Analysing…" : label}
    </Button>
  );
}

/** "Resume all": every merged pull request Autopilot paused for want of AI credits (Home). */
export function ResumeAllButton({ projectSlug }: { projectSlug: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await resumeCodeChanges(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else if (result.failed) {
            toast.warning(`Resumed; ${result.failed === 1 ? "1 analysis" : `${result.failed} analyses`} stopped. See Autopilot.`);
          } else {
            toast.success("Resumed");
          }
        })
      }
    >
      {pending ? "Resuming…" : "Resume all"}
    </Button>
  );
}
