import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { changelogReach } from "@tuti/jobs";

import { Button } from "@/components/ui/button";
import { CONFIRM_LINK_HOURS, findConfirmation, findSubscription, reachSentence } from "@/server/changelog-subscription";
import { portalLinks } from "@/server/portal-base";
import { MESSAGE_TEXT, MESSAGE_TITLE, PortalMessage } from "@/components/portal-message";
import { BellIcon } from "lucide-react";
import { PRIVATE_PAGE } from "@/server/portal-metadata";
import { pageTranslator } from "@/server/portal-language";

/** For the reader alone: not for search engines. In the address's language, as the page (its emails link there). */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await pageTranslator("subscription")).t("title"), ...PRIVATE_PAGE };
}

const heading = MESSAGE_TITLE;
const text = MESSAGE_TEXT;

/**
 * A changelog subscription's page, from its links: the confirmation email's (`confirm`) and every changelog email's
 * (`token`: Unsubscribe). Buttons that post, so mail scanners opening links change nothing. Works signed out. What it
 * says comes from changelogReach, the sender's own rule.
 */
export default async function ChangelogSubscriptionPage(props: PageProps<"/portal/[project]/changelog/subscription">) {
  const [{ project: slug }, { token, confirm, sent }] = await Promise.all([props.params, props.searchParams]);
  const at = await portalLinks();
  // In the address's language: the emails link to their reader's.
  const { t, language } = await pageTranslator("subscription");
  const link = (chunks: React.ReactNode) => (
    <a href={at("/changelog")} className="underline">
      {chunks}
    </a>
  );

  if (typeof confirm === "string") {
    const request = await findConfirmation(slug, confirm);
    if (!request) {
      const project = await prisma.project.findUnique({ where: { slug }, select: { portalAccess: true } });
      return (
        <Message>
          <h1 className={heading}>{t("deadTitle")}</h1>
          <p className={text}>
            {t("deadText", { hours: CONFIRM_LINK_HOURS })}
            {/* A private portal's box is its readers': the link has them sign in first. */}
            {project && <> {t.rich("askAgain", { link })}</>}
          </p>
        </Message>
      );
    }
    const { name } = request.project;
    // Used: where they stand, and nothing more (no controls: anyone may hold an old link, a forwarded one say).
    if (request.used) {
      return (
        <Message>
          <h1 className={heading}>{t("alreadyTitle")}</h1>
          <p className={text}>
            {reachSentence(request.reach, name, request.email, language)} {t("ownLinks", { name })}
          </p>
        </Message>
      );
    }
    if (request.reach === "private") {
      return <PrivatePortal name={name} t={t} />;
    }
    const action = at(`/changelog/subscription/confirm?confirm=${encodeURIComponent(confirm)}`);
    // Turned all of the project's emails off: that wins, so it says so first, and its one button turns them back on.
    if (request.reach === "opted-out") {
      return (
        <Message>
          <h1 className={heading}>{t("offTitle", { name })}</h1>
          <p className={text}>{t("offText", { name, email: request.email })}</p>
          <form method="post" action={action}>
            <input type="hidden" name="emails-on" value="1" />
            <Button type="submit">{t("turnOn", { name })}</Button>
          </form>
        </Message>
      );
    }
    return (
      <Message>
        <h1 className={heading}>{t("confirmTitle", { name })}</h1>
        {/* Not confirmed yet (reach is where confirming leaves them: gets, or paused): what happens once they are. */}
        <p className={text}>{t(request.reach === "paused" ? "confirmTextPaused" : "confirmText", { name, email: request.email })}</p>
        <form method="post" action={action}>
          <Button type="submit">{t("confirmButton")}</Button>
        </form>
      </Message>
    );
  }

  const value = typeof token === "string" ? token : "";
  const found = await findSubscription(slug, value);
  if (!found) {
    return (
      <Message>
        <h1 className={heading}>{t("brokenTitle")}</h1>
        <p className={text}>{t("brokenText")}</p>
      </Message>
    );
  }
  const { name } = found.project;
  // Every confirmed subscription can end itself here.
  const unsubscribe = (
    <form method="post" action={at(`/changelog/subscription/unsubscribe?token=${encodeURIComponent(value)}`)}>
      <Button type="submit" variant="outline">
        {t("unsubscribe")}
      </Button>
    </form>
  );
  switch (found.reach) {
    case "unconfirmed": {
      // The way back only for an address that could have it again: on a private portal, one of its readers.
      const canReturn = (await changelogReach(found.projectId, { email: found.email, confirmed: true })) !== "private";
      // Unsubscribed (this link only unsubscribes): asking again on the changelog signs them up again.
      return (
        <Message>
          <h1 className={heading}>{t("unsubscribedTitle")}</h1>
          <p className={text}>
            {t("unsubscribedText", { name, email: found.email })}
            {canReturn && <> {t.rich("subscribeAgain", { link })}</>}
          </p>
        </Message>
      );
    }
    case "private":
      return <PrivatePortal name={name} email={found.email} unsubscribe={unsubscribe} t={t} />;
    case "opted-out":
      // That wins. This long-lived link can't turn them back on (a forwarded email has it): it emails the address a link that can.
      return (
        <Message>
          <h1 className={heading}>{t("notEmailedTitle", { name })}</h1>
          <p className={text}>
            {reachSentence(found.reach, name, found.email, language)}{" "}
            {t(found.paused ? "pausedComeBack" : sent ? "sentLink" : "willEmailLink", { name, email: found.email })}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* Not while paused: nothing could be sent (emails-on refuses). */}
            {!sent && !found.paused && (
              <form method="post" action={at(`/changelog/subscription/emails-on?token=${encodeURIComponent(value)}`)}>
                <Button type="submit">{t("emailMeLink")}</Button>
              </form>
            )}
            {unsubscribe}
          </div>
        </Message>
      );
    case "gets":
    case "paused":
      return (
        <Message>
          <h1 className={heading}>{t("getsTitle", { name })}</h1>
          <p className={text}>{reachSentence(found.reach, name, found.email, language)}</p>
          {unsubscribe}
        </Message>
      );
  }
}

type Translate = Awaited<ReturnType<typeof pageTranslator<"subscription">>>["t"];

/** A subscription page's card, with the bell. */
const Message = ({ children }: { children: React.ReactNode }) => <PortalMessage icon={BellIcon}>{children}</PortalMessage>;

/** Nothing is emailed from a private portal (changelogReach): nothing to confirm, and Unsubscribe still works. */
function PrivatePortal({ name, email, unsubscribe, t }: { name: string; email?: string; unsubscribe?: React.ReactNode; t: Translate }) {
  return (
    <Message>
      <h1 className={heading}>{t("privateTitle")}</h1>
      <p className={text}>{email ? t("privateTextEmail", { name, email }) : t("privateText", { name })}</p>
      {unsubscribe}
    </Message>
  );
}
