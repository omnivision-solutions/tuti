"use client";

import { useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { approveEmailSending, requestEmailSending } from "@/server/email-approval";

/** The operator's approval page: what's asked, and the button that approves it. */
export function ApproveEmailButton({ token, projectName, portalUrl }: { token: string; projectName: string; portalUrl: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<{ title: string; approved: boolean }>();
  if (done) {
    return <EmptyState title={done.title} description={done.approved ? "Its replies are emailed to its users from now on." : undefined} />;
  }
  return (
    <EmptyState
      title={`Let ${projectName} email its users?`}
      description={`Replies from its support inbox go to its users by email once you approve. Look at its portal first: ${portalUrl}`}
      action={
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await approveEmailSending(token);
              setDone(result.error ? { title: result.error, approved: false } : { title: `${projectName} is approved`, approved: true });
            })
          }
        >
          Approve
        </Button>
      }
    />
  );
}

/** Settings → Support, on a server selling plans: asks the operator to approve the project. */
export function RequestEmailButton({ projectSlug }: { projectSlug: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  // Once asked, the page says so (it shows when).
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => startTransition(async () => setError((await requestEmailSending(projectSlug)).error))}
      >
        Request email sending
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
