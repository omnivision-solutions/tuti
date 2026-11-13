import { ClockIcon } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";

/** How many days are left of a trial ending at `endsAt`: a part of a day counts as one. */
export const daysLeft = (endsAt: Date, now = new Date()) => Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000));

/** Every project page during a free trial and after it ended without a plan: what's left, and Billing's plans for owners and admins. */
export function TrialNotice({ projectSlug, trial, admin }: { projectSlug: string; trial: { endsAt: Date; ended: boolean }; admin: boolean }) {
  const days = daysLeft(trial.endsAt);
  return (
    <Alert>
      <ClockIcon />
      <AlertDescription>
        <p>
          {trial.ended ? "Your trial has ended." : `${days} ${days === 1 ? "day" : "days"} left in your trial.`}{" "}
          {admin ? (
            <Link href={`/app/${projectSlug}/settings/billing`} className="underline underline-offset-4">
              Choose a plan
            </Link>
          ) : (
            trial.ended && "An owner or admin can choose a plan."
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
