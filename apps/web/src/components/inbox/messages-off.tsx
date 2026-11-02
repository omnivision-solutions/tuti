import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Says the widget has no Messages tab (Settings → Inbox and email's switch), with a link to it for owners and admins.
 * A note, not an alert: it's there on every Inbox page, so screen readers shouldn't cut in with it each time.
 */
export function MessagesOffNotice({ projectSlug, admin }: { projectSlug: string; admin: boolean }) {
  return (
    <Alert role="note">
      <AlertDescription>
        <p>
          Messages in the widget is off, so your users can&apos;t write to you from the widget.{" "}
          {admin && (
            <Link href={`/app/${projectSlug}/settings/support`} className="underline underline-offset-4">
              Turn it on
            </Link>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
