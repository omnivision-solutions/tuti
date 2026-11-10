import Link from "next/link";
import { MessageSquareIcon, ArrowRightIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Says the widget has no Messages tab (Settings → Inbox and email's switch), with a link to it for owners and admins.
 * A note, not an alert: it's there on every Inbox page, so screen readers shouldn't cut in with it each time.
 */
export function MessagesOffNotice({ projectSlug, admin }: { projectSlug: string; admin: boolean }) {
  return (
    <Alert role="note" className="grid-cols-[0.9375rem_1fr]! gap-x-2.25! rounded-none border-0 p-0 text-xs text-muted-foreground shadow-none">
      <MessageSquareIcon aria-hidden className="size-3.5" />
      <AlertDescription className="text-xs leading-5 [&_a]:no-underline">
        <p className="text-xs leading-5">
          Messages in the widget is off.
          {admin && (
            <Link href={`/app/${projectSlug}/settings/support`} className="inbox-messages-on mt-0.5 flex w-fit items-center gap-1 text-xs leading-5 font-[550] text-foreground no-underline [&>svg]:size-3.25">
              Turn it on <ArrowRightIcon aria-hidden />
            </Link>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
