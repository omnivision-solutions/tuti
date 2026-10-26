import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { BADGE_PRICE, licenseBilling } from "@/lib/plans";
import { buyLicense } from "@/server/license-checkout";
import { LICENSE_ID, licensePrice } from "@/server/license-sales";
import { licensePrivateKey } from "@/server/license-server";

export const metadata: Metadata = { title: 'Remove "Powered by tuti"', robots: { index: false } };

/** Where licences are sold without Stripe, and where a bought one is cancelled without Stripe's customer portal. */
const LICENSE_EMAIL = "hello@tuti.so";

/**
 * tuti.so/license?installation=…&project=… is where "Get a licence" in Customize → Powered by goes,
 * on any installation: a licence is for that project on that installation, so the page shows both
 * ids, and buys it for them with Stripe Checkout (or, without Stripe, says to email). Only on Tuti's
 * own installation, the licence server.
 */
export default async function LicensePage(props: PageProps<"/license">) {
  if (!licensePrivateKey()) {
    notFound();
  }
  const { installation, project, paid, failed } = await props.searchParams;
  if (typeof installation !== "string" || typeof project !== "string" || !LICENSE_ID.test(installation) || !LICENSE_ID.test(project)) {
    return (
      <EmptyState
        title="Open this page from your Tuti"
        description='In Customize → Powered by, untick "Powered by tuti" and choose Get a licence: the link says which project it is for.'
      />
    );
  }
  const license = await prisma.license.findUnique({
    where: { installationId_projectId: { installationId: installation, projectId: project } },
    select: { active: true, stripeSubscriptionId: true },
  });
  const monthly = licensePrice("month");
  const yearly = licensePrice("year");
  const billing = licenseBilling({ month: Boolean(monthly), year: Boolean(yearly) });
  const portal = process.env.STRIPE_PORTAL_LOGIN_URL?.trim();
  const body = `Hi,\n\nI'd like a licence to remove "Powered by tuti".\n\nInstallation ID: ${installation}\nProject ID: ${project}\n`;
  const mailto = `mailto:${LICENSE_EMAIL}?${new URLSearchParams({ subject: "Tuti licence", body }).toString().replaceAll("+", "%20")}`;
  const email = <a href={mailto} className="font-medium text-primary underline-offset-4 hover:underline">{LICENSE_EMAIL}</a>;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Remove &quot;Powered by tuti&quot;</h1>
        <p className="text-muted-foreground">
          A licence hides &quot;Powered by tuti&quot; on one project&apos;s portal, for {billing.price}. It&apos;s for
          this project on this installation of Tuti:
        </p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
        <dt className="text-sm font-medium">Installation ID</dt>
        <dd>
          <code className="rounded-md bg-muted px-2 py-1 font-mono text-sm break-all">{installation}</code>
        </dd>
        <dt className="text-sm font-medium">Project ID</dt>
        <dd>
          <code className="rounded-md bg-muted px-2 py-1 font-mono text-sm break-all">{project}</code>
        </dd>
      </dl>
      {license?.active ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="font-medium">This project is licensed.</p>
          <p>
            In Customize → Powered by, choose Check now (or wait for the daily check), then untick &quot;Powered by tuti&quot;.
          </p>
          {license.stripeSubscriptionId && (
            <p className="text-sm text-muted-foreground">
              {portal ? (
                <>
                  To cancel it, change the card or get invoices,{" "}
                  <a href={portal} className="font-medium text-primary underline-offset-4 hover:underline">
                    manage your billing
                  </a>{" "}
                  with the email you paid with.
                </>
              ) : (
                <>To cancel it, change the card or get invoices, email {email}.</>
              )}
            </p>
          )}
        </div>
      ) : paid ? (
        <p role="status">
          Thanks! The licence turns on as soon as Stripe confirms the payment, usually within seconds: reload this page to see it.
        </p>
      ) : monthly || yearly ? (
        <form action={buyLicense} className="flex flex-col gap-3">
          <input type="hidden" name="installation" value={installation} />
          <input type="hidden" name="project" value={project} />
          {failed && <p className="text-sm text-destructive">Couldn&apos;t open Stripe&apos;s checkout. Try again in a moment.</p>}
          <p>Pay by card with Stripe, {billing.billed}. It renews until you cancel it.</p>
          <div className="flex flex-wrap gap-2">
            {monthly && (
              <Button type="submit" name="interval" value="month">
                Buy for ${BADGE_PRICE} a month
              </Button>
            )}
            {yearly && (
              <Button type="submit" name="interval" value="year" variant={monthly ? "outline" : "default"}>
                Buy for ${BADGE_PRICE * 12} a year
              </Button>
            )}
          </div>
        </form>
      ) : (
        <>
          <p>
            To buy one, email {email} with both IDs. Once it&apos;s active, choose Check now in Customize → Powered by, or wait for the daily check.
          </p>
          <a href={mailto} className={buttonVariants({ className: "self-start" })}>
            Email {LICENSE_EMAIL}
          </a>
        </>
      )}
    </div>
  );
}
