import { mediaPublicUrl } from "@tuti/shared/storage";
import { RssIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChangelogEntryView } from "@/components/changelog-entry";
import { ChangelogSeen } from "@/components/changelog-seen";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { portalAddress } from "@/server/custom-domains";
import { Separator } from "@/components/ui/separator";
import { publishedEntries } from "@/server/changelog-queries";
import { latestAnnouncedAt } from "@/server/operations/changelog-seen";
import { getSession } from "@/server/session";
import { portalBase, portalLinks } from "@/server/portal-base";

const PAGE_SIZE = 20;

/** A changelog page's path: /changelog, then /changelog/page/2 and on. */
export const changelogPath = (page: number) => (page === 1 ? "/changelog" : `/changelog/page/${page}`);

/** Feed readers find the RSS feed from the page: a full URL on the project's portal. */
export async function changelogMetadata(slug: string): Promise<Metadata> {
  return {
    alternates: { types: { "application/rss+xml": [{ url: `${await portalAddress(slug)}/changelog/rss.xml`, title: "Changelog" }] } },
  };
}

/**
 * What shipped, newest first, a page at a time (/changelog, then /changelog/page/2 for older ones).
 * Past the last page it's a 404: a function the pages call, not a component, so that happens before
 * they render.
 */
export async function changelogPage(slug: string, page: number) {
  const at = await portalLinks();
  const base = await portalBase();
  // One more than a page, to know whether there are older ones.
  const session = await getSession();
  const [found, announced] = await Promise.all([
    publishedEntries(slug, { take: PAGE_SIZE + 1, skip: (page - 1) * PAGE_SIZE, userId: session?.user.id }),
    // The newest entries are on the first page: viewing it, a signed-in user has seen them (the nav's "New" goes).
    session && page === 1 ? latestAnnouncedAt({ slug }) : null,
  ]);
  const entries = found.slice(0, PAGE_SIZE);
  if (entries.length === 0 && page > 1) {
    notFound();
  }
  const older = found.length > PAGE_SIZE;
  return (
    <div className="flex flex-col gap-8">
      {announced && <ChangelogSeen projectSlug={slug} at={announced.toISOString()} signedIn />}
      <PageHeader
        title="Changelog"
        description="What's new, improved and fixed."
        actions={
          <a href={at("/changelog/rss.xml")} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <RssIcon aria-hidden /> RSS
          </a>
        }
      />
      {entries.length === 0 ? (
        <EmptyState title="Nothing here yet" description="New features and fixes show up here as they ship." />
      ) : (
        entries.map((entry, i) => (
          <div key={entry.number} className="flex flex-col gap-8">
            {i > 0 && <Separator />}
            <ChangelogEntryView entry={entry} mediaBaseUrl={mediaPublicUrl()} react={{ projectSlug: slug, signedIn: !!session }} base={base} />
          </div>
        ))
      )}
      {(older || page > 1) && (
        <nav aria-label="Changelog pages" className="flex justify-between gap-4">
          {page > 1 ? (
            <Link href={at(changelogPath(page - 1))} className={buttonVariants({ variant: "outline" })}>
              Newer entries
            </Link>
          ) : (
            <span />
          )}
          {older && (
            <Link href={at(changelogPath(page + 1))} className={buttonVariants({ variant: "outline" })}>
              Older entries
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
