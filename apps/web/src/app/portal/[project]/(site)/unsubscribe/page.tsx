import { Button } from "@/components/ui/button";
import { findOptOut } from "@/server/unsubscribe";
import { portalLinks } from "@/server/portal-base";
import { MESSAGE_TEXT, MESSAGE_TITLE, PortalMessage } from "@/components/portal-message";
import { BellOffIcon } from "lucide-react";

export default async function UnsubscribePage(props: PageProps<"/portal/[project]/unsubscribe">) {
  const [{ project: slug }, { token }] = await Promise.all([props.params, props.searchParams]);
  const value = typeof token === "string" ? token : "";
  const found = await findOptOut(slug, value);

  return (
    <PortalMessage icon={BellOffIcon}>
      {!found ? (
        <>
          <h1 className={MESSAGE_TITLE}>This link doesn&apos;t work</h1>
          <p className={MESSAGE_TEXT}>Use the unsubscribe link from the latest email you got.</p>
        </>
      ) : found.optedOut ? (
        <>
          <h1 className={MESSAGE_TITLE}>You&apos;re unsubscribed</h1>
          <p className={MESSAGE_TEXT}>{found.project.name} won&apos;t email you anymore.</p>
        </>
      ) : (
        <>
          <h1 className={MESSAGE_TITLE}>Stop emails from {found.project.name}?</h1>
          <p className={MESSAGE_TEXT}>
            You&apos;ll stop getting {found.project.name}&apos;s emails: news and replies on posts you follow, wrote, voted or commented
            on, and its changelog.
          </p>
          <form method="post" action={(await portalLinks())(`/unsubscribe/confirm?token=${encodeURIComponent(value)}`)}>
            <Button type="submit" variant="outline">
              Unsubscribe
            </Button>
          </form>
        </>
      )}
    </PortalMessage>
  );
}
