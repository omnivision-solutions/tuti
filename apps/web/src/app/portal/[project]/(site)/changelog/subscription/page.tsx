import { Button } from "@/components/ui/button";
import { findSubscription } from "@/server/changelog-subscription";
import { portalLinks } from "@/server/portal-base";

/**
 * A changelog subscription's page, from its links: the confirmation email's (Confirm) and every changelog email's
 * (Unsubscribe). Buttons that post, so mail scanners opening links change nothing. Works signed out.
 */
export default async function ChangelogSubscriptionPage(props: PageProps<"/portal/[project]/changelog/subscription">) {
  const [{ project: slug }, { token }] = await Promise.all([props.params, props.searchParams]);
  const value = typeof token === "string" ? token : "";
  const found = await findSubscription(slug, value);
  const at = await portalLinks();
  const query = `?token=${encodeURIComponent(value)}`;
  const privatePortal = found?.project.portalAccess !== "PUBLIC";

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 py-12">
      {!found ? (
        <>
          <h1 className="font-heading text-2xl font-bold">This link doesn&apos;t work</h1>
          <p className="text-muted-foreground">Use the link from the latest email you got.</p>
        </>
      ) : found.unsubscribedAt ? (
        // Old links don't sign them up again: asking again on the changelog does.
        <>
          <h1 className="font-heading text-2xl font-bold">You&apos;re unsubscribed</h1>
          <p className="text-muted-foreground">
            {found.project.name}&apos;s changelog won&apos;t be emailed to {found.email} anymore.
            {!privatePortal && (
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
        </>
      ) : privatePortal ? (
        // Nothing is emailed from a private portal (changelogEmailed): no Confirm, and Unsubscribe still works.
        <>
          <h1 className="font-heading text-2xl font-bold">Updates by email aren&apos;t available here</h1>
          <p className="text-muted-foreground">
            {found.project.name}&apos;s portal is private, so its changelog isn&apos;t emailed{found.confirmedAt ? ` to ${found.email}` : ""}.
          </p>
          {found.confirmedAt && (
            <form method="post" action={at(`/changelog/subscription/unsubscribe${query}`)}>
              <Button type="submit" variant="outline">
                Unsubscribe
              </Button>
            </form>
          )}
        </>
      ) : found.confirmedAt ? (
        <>
          <h1 className="font-heading text-2xl font-bold">You get {found.project.name}&apos;s updates by email</h1>
          <p className="text-muted-foreground">
            New entries in the changelog go to {found.email} as they&apos;re published.
          </p>
          <form method="post" action={at(`/changelog/subscription/unsubscribe${query}`)}>
            <Button type="submit" variant="outline">
              Unsubscribe
            </Button>
          </form>
        </>
      ) : (
        <>
          <h1 className="font-heading text-2xl font-bold">Get {found.project.name}&apos;s updates by email?</h1>
          <p className="text-muted-foreground">New entries in the changelog go to {found.email} as they&apos;re published.</p>
          <form method="post" action={at(`/changelog/subscription/confirm${query}`)}>
            <Button type="submit">Confirm</Button>
          </form>
        </>
      )}
    </div>
  );
}
