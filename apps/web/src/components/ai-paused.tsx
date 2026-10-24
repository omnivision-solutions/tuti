import { PauseCircleIcon } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** Says the project's AI is paused (out of AI credits), what that stops, and where credits come from: Billing for owners and admins. */
export function AiPaused({ projectSlug, stops, admin }: { projectSlug: string; stops: string; admin: boolean }) {
  return (
    <Alert>
      <PauseCircleIcon />
      <AlertTitle>This project is out of AI credits</AlertTitle>
      <AlertDescription>
        {stops} until it has more.{" "}
        {admin ? (
          <Link href={`/app/${projectSlug}/settings/billing`} className="underline underline-offset-4">
            See Billing
          </Link>
        ) : (
          "An owner or admin can add them."
        )}
      </AlertDescription>
    </Alert>
  );
}
