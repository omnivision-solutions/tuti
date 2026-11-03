"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { verifyArticle } from "@/server/code-changes";

/** Verify on an article (articles.verify): says what it found, then the panel shows it in the history. */
export function VerifyButton({ projectSlug, slug }: { projectSlug: string; slug: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const verify = () =>
    startTransition(async () => {
      const { error, verification: run } = await verifyArticle(projectSlug, slug);
      if (error || !run) {
        toast.error(error ?? "Couldn't verify it");
      } else if (run.state === "failed") {
        toast.error(run.reason);
      } else if (run.state === "running") {
        toast.success("Verifying: it's in the history when it's done");
      } else if (run.state === "done") {
        toast.success(run.fix ? `Verified: ${run.counts.outdated} out of date, its fix waits for you` : run.counts.outdated > 0 ? run.reason : "Verified: nothing out of date");
      } else {
        toast.success(run.reason);
      }
      router.refresh();
    });
  return (
    <Button disabled={pending} focusableWhenDisabled onClick={verify}>
      {pending ? "Verifying…" : "Verify"}
    </Button>
  );
}
