import { planNeeded, type PlanFeature } from "@tuti/shared";
import Link from "next/link";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";

/** Says the project's plan doesn't include `feature` and what still works (`children`), with a link to Billing for owners and admins. */
export function PlanNotice({ feature, projectSlug, admin, children }: { feature: PlanFeature; projectSlug: string; admin: boolean; children?: ReactNode }) {
  return (
    <Alert>
      <AlertDescription>
        <p>
          {planNeeded(feature)} {children}{" "}
          {admin && (
            <Link href={`/app/${projectSlug}/settings/billing`} className="underline underline-offset-4">
              See Billing
            </Link>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
