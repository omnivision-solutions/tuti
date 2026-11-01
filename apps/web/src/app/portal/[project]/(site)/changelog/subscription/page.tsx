import { Button } from "@/components/ui/button";
import { CONFIRM_LINK_HOURS, findConfirmation, findSubscription } from "@/server/changelog-subscription";
import { portalLinks } from "@/server/portal-base";

/**
 * A changelog subscription's page, from its links: the confirmation email's (`confirm`: Get updates by email) and
 * every changelog email's (`token`: Unsubscribe). Buttons that post, so mail scanners opening links change nothing.
 * Works signed out.
 */
export default async function ChangelogSubscriptionPage(props: PageProps<"/portal/[project]/changelog/subscription">) {
  const [{ project: slug }, { token, confirm }] = await Promise.all([props.params, props.searchParams]);
  const at = await portalLinks();
  const heading = "font-heading text-2xl font-bold";
  const text = "break-words text-muted-foreground";

  if (typeof confirm === "string") {
    const request = await findConfirmation(slug, confirm);
    if (!request) {
      return (
        <Message>
          <h1 className={heading}>This link doesn&apos;t work any more</h1>
          <p className={text}>
            A confirmation link works once, for {CONFIRM_LINK_HOURS} hours, and only the latest one you were sent. To get
            updates by email, ask again on the{" "}
            <a href={at("/changelog")} className="underline">
              changelog
            </a>
            .
          </p>
        </Message>
      );
    }
    if (request.project.portalAccess !== "PUBLIC") {
      return <PrivatePortal name={request.project.name} />;
    }
    return (
      <Message>
        <h1 className={heading}>Get {request.project.name}&apos;s updates by email?</h1>
        <p className={text}>New entries in the changelog go to {request.email} as they&apos;re published.</p>
        <form method="post" action={at(`/changelog/subscription/confirm?confirm=${encodeURIComponent(confirm)}`)}>
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
