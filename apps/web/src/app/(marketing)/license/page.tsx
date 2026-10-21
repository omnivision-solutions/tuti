import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { licensePrivateKey } from "@/server/license-server";

export const metadata: Metadata = { title: 'Remove "Powered by tuti"', robots: { index: false } };

/** Where licences are sold until there's a checkout: by email. */
const LICENSE_EMAIL = "hello@tuti.so";

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * tuti.so/license?installation=…&project=… is where "Get a licence" in Settings → Branding goes,
 * on any installation: a licence is for that project on that installation, so the page shows both
 * ids to buy it for. Only on Tuti's own installation, the licence server.
 */
export default async function LicensePage(props: PageProps<"/license">) {
  if (!licensePrivateKey()) {
    notFound();
  }
  const { installation, project } = await props.searchParams;
  if (typeof installation !== "string" || typeof project !== "string" || !ID.test(installation) || !ID.test(project)) {
    return (
      <EmptyState
        title="Open this page from your Tuti"
        description='In Settings → Branding, untick "Powered by tuti" and choose Get a licence: the link says which project it is for.'
      />
    );
  }
  const body = `Hi,\n\nI'd like a licence to remove "Powered by tuti".\n\nInstallation ID: ${installation}\nProject ID: ${project}\n`;
  const mailto = `mailto:${LICENSE_EMAIL}?${new URLSearchParams({ subject: "Tuti licence", body }).toString().replaceAll("+", "%20")}`;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Remove &quot;Powered by tuti&quot;</h1>
        <p className="text-muted-foreground">
          A licence hides &quot;Powered by tuti&quot; on one project&apos;s portal, for a flat monthly fee. It&apos;s for
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
      <p>
        To buy one, email <a href={mailto} className="font-medium text-primary underline-offset-4 hover:underline">{LICENSE_EMAIL}</a>{" "}
        with both IDs. Once it&apos;s active, choose Check now in Settings → Branding, or wait for the daily check.
      </p>
      <a href={mailto} className={buttonVariants({ className: "self-start" })}>
        Email {LICENSE_EMAIL}
      </a>
    </div>
  );
}
