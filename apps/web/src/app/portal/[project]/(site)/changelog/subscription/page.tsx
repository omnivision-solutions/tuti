import { prisma } from "@tuti/db";

import { Button } from "@/components/ui/button";
import { CONFIRM_LINK_HOURS, findConfirmation, findSubscription } from "@/server/changelog-subscription";
import { portalLinks } from "@/server/portal-base";

/**
 * A changelog subscription's page, from its links: the confirmation email's (`confirm`: Get updates by email) and
 * every changelog email's (`token`: Unsubscribe). Buttons that post, so mail scanners opening links change nothing.
 * Works signed out.
 */
export default async function ChangelogSubscriptionPage(props: PageProps<"/portal/[project]/changelog/subscription">) {
  const [{ project: slug }, { token, confirm, sent }] = await Promise.all([props.params, props.searchParams]);
  const at = await portalLinks();
  const heading = "font-heading text-2xl font-bold";
  const text = "break-words text-muted-foreground";

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
            {project?.portalAccess === "PUBLIC" && (
              <>
                {" "}
                To get updates by email, ask again on the{" "}
                <a href={at("/changelog")} className="underline">
                  changelog
                </a>
                .
              </>
            )}
          </p>
        </Message>
      );
    }
    // Used: it says so, and nothing more (no controls: anyone may hold an old link, a forwarded one say).
    if (request.used) {
      return (
        <Message>
          <h1 className={heading}>Already confirmed</h1>
          <p className={text}>This link has been used. The emails {request.project.name} sends you have their own links to unsubscribe.</p>
        </Message>
      );
    }
    if (request.project.portalAccess !== "PUBLIC") {
      return <PrivatePortal name={request.project.name} />;
    }
    const action = at(`/changelog/subscription/confirm?confirm=${encodeURIComponent(confirm)}`);
    // Turned all of the project's emails off: that wins, so it says so first, and its one button turns them back on.
    if (request.optedOut) {
      return (
        <Message>
          <h1 className={heading}>You&apos;ve turned off all of {request.project.name}&apos;s emails</h1>
          <p className={text}>
            Nothing is emailed to {request.email}, the changelog included, until you turn them back on. Then you&apos;ll
            get its new entries, and hear when posts you asked for are done.
          </p>
          <form method="post" action={action}>
            <input type="hidden" name="emails-on" value="1" />
            <Button type="submit">Turn {request.project.name}&apos;s emails back on</Button>
          </form>
        </Message>
      );
    }
    return (
      <Message>
        <h1 className={heading}>Get {request.project.name}&apos;s updates by email?</h1>
        <p className={text}>New entries in the changelog go to {request.email} as they&apos;re published.</p>
        <form method="post" action={action}>
          <Button type="submit">Get updates by email</Button>
        </form>
      </Message>
    );
  }

  const value = typeof token === "string" ? token : "";

  const found = await findSubscription(slug, value);
  const unsubscribe = (
    <form method="post" action={at(`/changelog/subscription/unsubscribe?token=${encodeURIComponent(value)}`)}>
      <Button type="submit" variant="outline">
        Unsubscribe
      </Button>
    </form>
  );
  if (!found) {
    return (
      <Message>
        <h1 className={heading}>This link doesn&apos;t work</h1>
        <p className={text}>Use the link from the latest email you got.</p>
      </Message>
    );
  }
  if (!found.confirmedAt) {
    // Unsubscribed (this link only unsubscribes): asking again on the changelog signs them up again.
    return (
      <Message>
        <h1 className={heading}>You&apos;re unsubscribed</h1>
        <p className={text}>
          {found.project.name}&apos;s changelog won&apos;t be emailed to {found.email} anymore.
          {found.project.portalAccess === "PUBLIC" && (
            <>
              {" "}
              To get it again, subscribe on the{" "}
              <a href={at("/changelog")} className="underline">
                changelog
              </a>
              .
            </>
          )}
        </p>
      </Message>
    );
  }
  if (found.project.portalAccess !== "PUBLIC") {
    return <PrivatePortal name={found.project.name} email={found.email} unsubscribe={unsubscribe} />;
  }
  if (!found.receiving) {
    // Confirmed, but they've turned all of the project's emails off (a shipped email's Unsubscribe): that wins. This
    // long-lived link can't turn them back on (a forwarded email has it): it emails the address a link that can.
    return (
      <Message>
        <h1 className={heading}>You&apos;ve turned off all of {found.project.name}&apos;s emails</h1>
        <p className={text}>
          So its changelog isn&apos;t emailed to {found.email} either.{" "}
          {sent ? `We sent ${found.email} a link to turn them back on.` : `To turn them back on, we'll email ${found.email} a link.`}
        </p>
        <div className="flex flex-wrap gap-2">
          {!sent && (
            <form method="post" action={at(`/changelog/subscription/emails-on?token=${encodeURIComponent(value)}`)}>
              <Button type="submit">Email me a link</Button>
            </form>
          )}
          {unsubscribe}
        </div>
      </Message>
    );
  }
  return (
    <Message>
      <h1 className={heading}>You get {found.project.name}&apos;s updates by email</h1>
      <p className={text}>New entries in the changelog go to {found.email} as they&apos;re published.</p>
      {unsubscribe}
    </Message>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-md flex-col gap-4 py-12">{children}</div>;
}

/** Nothing is emailed from a private portal (changelogEmailed): nothing to confirm, and Unsubscribe still works. */
function PrivatePortal({ name, email, unsubscribe }: { name: string; email?: string; unsubscribe?: React.ReactNode }) {
  return (
    <Message>
      <h1 className="font-heading text-2xl font-bold">Updates by email aren&apos;t available here</h1>
      <p className="break-words text-muted-foreground">
        {name}&apos;s portal is private, so its changelog isn&apos;t emailed{email ? ` to ${email}` : ""}.
      </p>
      {unsubscribe}
    </Message>
  );
}
