"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { analyseCodeChange, publishCodeChangesNow, resumeCodeChanges, stopCodeChanges } from "@/server/code-changes";

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

/**
 * Publish now and Stop for scheduled updates (one on the review page; a change's on Home): they go out
 * at once, or wait for the team. One that emails people (completing a request) asks first.
 */
export function ScheduledButtons({ projectSlug, actionIds, emails = 0 }: { projectSlug: string; actionIds: string[]; emails?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const one = actionIds.length === 1;
  const run = (act: typeof publishCodeChangesNow, done: string) =>
    startTransition(async () => {
      const result = await act(projectSlug, actionIds);
      setAsking(false);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(done);
      }
      router.refresh();
    });
  const publish = () => run(publishCodeChangesNow, "Published");
  return (
    <div className="flex gap-1">
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(stopCodeChanges, one ? "Stopped: it waits for you" : "Stopped: they wait for you")}>
        Stop
      </Button>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => (emails > 0 ? setAsking(true) : publish())}>
        Publish now
      </Button>
      <AlertDialog open={asking} onOpenChange={(open) => !pending && setAsking(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{one ? "Publish it now?" : "Publish them now?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {`Completing the request emails up to ${emails} ${emails === 1 ? "person" : "people"} who asked for it that it shipped. That can't be taken back.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={publish}>
              Publish now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
