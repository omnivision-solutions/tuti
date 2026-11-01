import { prisma } from "@tuti/db";

import { Button } from "@/components/ui/button";
import { CONFIRM_LINK_HOURS, findConfirmation, findSubscription, reachSentence } from "@/server/changelog-subscription";
import { portalLinks } from "@/server/portal-base";

const heading = "font-heading text-2xl font-bold";
const text = "break-words text-muted-foreground";

/**
 * A changelog subscription's page, from its links: the confirmation email's (`confirm`) and every changelog email's
 * (`token`: Unsubscribe). Buttons that post, so mail scanners opening links change nothing. Works signed out. What it
 * says comes from changelogReach, the sender's own rule.
 */
export default async function ChangelogSubscriptionPage(props: PageProps<"/portal/[project]/changelog/subscription">) {
  const [{ project: slug }, { token, confirm, sent }] = await Promise.all([props.params, props.searchParams]);
  const at = await portalLinks();
  const changelogLink = (
    <a href={at("/changelog")} className="underline">
      changelog
    </a>
  );

  if (typeof confirm === "string") {
    const request = await findConfirmation(slug, confirm);
    if (!request) {
      const project = await prisma.project.findUnique({ where: { slug }, select: { portalAccess: true } });
      return (
        <Message>
          <h1 className={heading}>This link doesn&apos;t work any more</h1>
          <p className={text}>
            A confirmation link works once, for {CONFIRM_LINK_HOURS} hours, and only the latest one you were sent.
            {/* Only where there's a box to ask in: a private portal has none. */}
            {project?.portalAccess === "PUBLIC" && <> To get updates by email, ask again on the {changelogLink}.</>}
          </p>
        </Message>
      );
    }
    const { name } = request.project;
    // Used: where they stand, and nothing more (no controls: anyone may hold an old link, a forwarded one say).
    if (request.used) {
      return (
        <Message>
          <h1 className={heading}>Already confirmed</h1>
          <p className={text}>
            {reachSentence(request.reach, name, request.email)} The emails {name} sends you have their own links to unsubscribe.
          </p>
        </Message>
      );
    }
    if (request.reach === "private") {
      return <PrivatePortal name={name} />;
    }
    const action = at(`/changelog/subscription/confirm?confirm=${encodeURIComponent(confirm)}`);
    // Turned all of the project's emails off: that wins, so it says so first, and its one button turns them back on.
    if (request.reach === "opted-out") {
      return (
        <Message>
          <h1 className={heading}>You&apos;ve turned off all of {name}&apos;s emails</h1>
          <p className={text}>
            Nothing is emailed to {request.email}, the changelog included, until you turn them back on. Then you&apos;ll
            get its new entries, and hear when posts you asked for are done.
          </p>
          <form method="post" action={action}>
            <input type="hidden" name="emails-on" value="1" />
            <Button type="submit">Turn {name}&apos;s emails back on</Button>
          </form>
        </Message>
      );
    }
    return (
      <Message>
        <h1 className={heading}>Get {name}&apos;s updates by email?</h1>
        <p className={text}>{reachSentence(request.reach, name, request.email)}</p>
        <form method="post" action={action}>
          <Button type="submit">Get updates by email</Button>
        </form>
      </Message>
    );
  }

  const value = typeof token === "string" ? token : "";
  const found = await findSubscription(slug, value);
  if (!found) {
    return (
      <Message>
        <h1 className={heading}>This link doesn&apos;t work</h1>
        <p className={text}>Use the link from the latest email you got.</p>
      </Message>
    );
  }
  const { name } = found.project;
  // Every confirmed subscription can end itself here.
  const unsubscribe = (
    <form method="post" action={at(`/changelog/subscription/unsubscribe?token=${encodeURIComponent(value)}`)}>
      <Button type="submit" variant="outline">
        Unsubscribe
      </Button>
    </form>
  );
  switch (found.reach) {
    case "unconfirmed":
      // Unsubscribed (this link only unsubscribes): asking again on the changelog signs them up again.
      return (
        <Message>
          <h1 className={heading}>You&apos;re unsubscribed</h1>
          <p className={text}>
            {name}&apos;s changelog won&apos;t be emailed to {found.email} anymore.
            {found.project.portalAccess === "PUBLIC" && <> To get it again, subscribe on the {changelogLink}.</>}
          </p>
        </Message>
      );
    case "private":
      return <PrivatePortal name={name} email={found.email} unsubscribe={unsubscribe} />;
    case "opted-out":
      // That wins. This long-lived link can't turn them back on (a forwarded email has it): it emails the address a link that can.
      return (
        <Message>
          <h1 className={heading}>{name}&apos;s changelog isn&apos;t emailed to you</h1>
          <p className={text}>
            {reachSentence(found.reach, name, found.email)}{" "}
            {found.paused
              ? `${name}'s emails are paused for now: come back here once they're resumed, and we'll email ${found.email} a link to turn them back on.`
              : sent
                ? `We sent ${found.email} a link to turn them back on.`
                : `To turn them back on, we'll email ${found.email} a link.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* Not while paused: nothing could be sent (emails-on refuses). */}
            {!sent && !found.paused && (
              <form method="post" action={at(`/changelog/subscription/emails-on?token=${encodeURIComponent(value)}`)}>
                <Button type="submit">Email me a link</Button>
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
          <h1 className={heading}>You get {name}&apos;s updates by email</h1>
          <p className={text}>{reachSentence(found.reach, name, found.email)}</p>
          {unsubscribe}
        </Message>
      );
  }
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-md flex-col gap-4 py-12">{children}</div>;
}

/** Nothing is emailed from a private portal (changelogReach): nothing to confirm, and Unsubscribe still works. */
function PrivatePortal({ name, email, unsubscribe }: { name: string; email?: string; unsubscribe?: React.ReactNode }) {
  return (
    <Message>
      <h1 className={heading}>Updates by email aren&apos;t available here</h1>
      <p className={text}>
        {name}&apos;s portal is private, so its changelog isn&apos;t emailed{email ? ` to ${email}` : ""}.
      </p>
      {unsubscribe}
    </Message>
  );
}
