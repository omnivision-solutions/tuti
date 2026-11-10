import Link from "next/link";
import { MessageSquareIcon, ArrowRightIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Says the widget has no Messages tab (Settings → Inbox and email's switch), with a link to it for owners and admins.
 * A note, not an alert: it's there on every Inbox page, so screen readers shouldn't cut in with it each time.
 */
export function MessagesOffNotice({ projectSlug, admin }: { projectSlug: string; admin: boolean }) {
  return (
    <Alert role="note">
      <MessageSquareIcon aria-hidden />
      <AlertDescription>
        <p>
          Messages in the widget is off.
          {admin && (
            <Link href={`/app/${projectSlug}/settings/support`} className="inbox-messages-on">
              Turn it on <ArrowRightIcon aria-hidden />
            </Link>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
