import { historyDays, longestHistoryDays, type PlanKey } from "@tuti/shared";
import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Says some of what a list would show is past the plan's history (docs/plan.md, Plans): `what`, "Closed conversations"
 * or the like, with nothing done in them for longer than the plan keeps. A link to Billing for owners and admins while
 * a plan keeps more. A note, not an alert: it's there each time the list is.
 */
export function PastHistoryNotice({ what, plan, projectSlug, admin }: { what: string; plan: PlanKey; projectSlug: string; admin: boolean }) {
  const days = historyDays(plan);
  return (
    <Alert role="note">
      <AlertDescription>
        <p>
          {what} with nothing done in them for more than {days} days are past your plan&apos;s history.{" "}
          {admin && days! < longestHistoryDays()! && (
            <Link href={`/app/${projectSlug}/settings/billing`} className="underline underline-offset-4">
              See plans
            </Link>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
