"use client";

import { useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { resumeEmailSending } from "@/server/email-pause";

/** The operator's page for a paused project: why it was paused, and the button that resumes it. */
export function ResumeEmailButton({ token, projectName, reason, portalUrl }: { token: string; projectName: string; reason: string; portalUrl: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<{ title: string; resumed: boolean }>();
  if (done) {
    return <EmptyState title={done.title} description={done.resumed ? "Its replies and updates are emailed to its users again." : undefined} />;
  }
  return (
    <EmptyState
      title={`Resume ${projectName}'s email?`}
      description={`Paused: ${reason}. Look at its portal first: ${portalUrl}. Once resumed, its rates count afresh.`}
      action={
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await resumeEmailSending(token);
              setDone(result.error ? { title: result.error, resumed: false } : { title: `${projectName}'s email is on again`, resumed: true });
            })
          }
        >
          Resume
        </Button>
      }
    />
  );
}
