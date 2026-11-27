import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { findOptOut } from "@/server/unsubscribe";
import { portalLinks } from "@/server/portal-base";
import { MESSAGE_TEXT, MESSAGE_TITLE, PortalMessage } from "@/components/portal-message";
import { BellOffIcon } from "lucide-react";
import { PRIVATE_PAGE } from "@/server/portal-metadata";
import { pageTranslator } from "@/server/portal-language";

/** For the reader alone: not for search engines. In the address's language, as the page (its emails link there). */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await pageTranslator("subscription")).t("unsubscribe"), ...PRIVATE_PAGE };
}

export default async function UnsubscribePage(props: PageProps<"/portal/[project]/unsubscribe">) {
  const [{ project: slug }, { token }] = await Promise.all([props.params, props.searchParams]);
  const value = typeof token === "string" ? token : "";
  const found = await findOptOut(slug, value);
  const { t } = await pageTranslator("subscription");

  return (
    <PortalMessage icon={BellOffIcon}>
      {!found ? (
        <>
          <h1 className={MESSAGE_TITLE}>{t("brokenTitle")}</h1>
          <p className={MESSAGE_TEXT}>{t("useLatestUnsubscribe")}</p>
        </>
      ) : found.optedOut ? (
        <>
          <h1 className={MESSAGE_TITLE}>{t("unsubscribedTitle")}</h1>
          <p className={MESSAGE_TEXT}>{t("allOffText", { name: found.project.name })}</p>
        </>
      ) : (
        <>
          <h1 className={MESSAGE_TITLE}>{t("stopTitle", { name: found.project.name })}</h1>
          <p className={MESSAGE_TEXT}>{t("stopText", { name: found.project.name })}</p>
          <form method="post" action={(await portalLinks())(`/unsubscribe/confirm?token=${encodeURIComponent(value)}`)}>
            <Button type="submit" variant="outline">
              {t("unsubscribe")}
            </Button>
          </form>
        </>
      )}
    </PortalMessage>
  );
}
