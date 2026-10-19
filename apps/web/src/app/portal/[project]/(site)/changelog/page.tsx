import { mediaPublicUrl } from "@tuti/shared/storage";
import { RssIcon } from "lucide-react";
import Link from "next/link";

import { ChangelogEntryView } from "@/components/changelog-entry";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { publishedEntries } from "@/server/changelog-queries";

const PAGE_SIZE = 20;

/** Feed readers find the RSS feed from the page. */
export const metadata = {
  alternates: { types: { "application/rss+xml": [{ url: "/changelog/rss.xml", title: "Changelog" }] } },
};

/** What shipped, newest first, a page at a time (`?page=2` for older ones). */
export default async function ChangelogPage(props: PageProps<"/portal/[project]/changelog">) {
  const [{ project: slug }, { page: param }] = await Promise.all([props.params, props.searchParams]);
  const page = Math.max(1, Math.min(10_000, Number(param) || 1));
  // One more than a page, to know whether there are older ones.
  const found = await publishedEntries(slug, { take: PAGE_SIZE + 1, skip: (page - 1) * PAGE_SIZE });
  const entries = found.slice(0, PAGE_SIZE);
  const older = found.length > PAGE_SIZE;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Changelog"
        description="What's new, improved and fixed."
        actions={
          <a href="/changelog/rss.xml" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <RssIcon aria-hidden /> RSS
          </a>
        }
      />
      {entries.length === 0 && page === 1 ? (
        <EmptyState title="Nothing here yet" description="New features and fixes show up here as they ship." />
      ) : (
        entries.map((entry, i) => (
          <div key={entry.number} className="flex flex-col gap-8">
            {i > 0 && <Separator />}
            <ChangelogEntryView entry={entry} mediaBaseUrl={mediaPublicUrl()} />
          </div>
        ))
      )}
      {(older || page > 1) && (
        <nav aria-label="Changelog pages" className="flex justify-between gap-4">
          {page > 1 ? (
            <Link href={page === 2 ? "/changelog" : `/changelog?page=${page - 1}`} className={buttonVariants({ variant: "outline" })}>
              Newer entries
            </Link>
          ) : (
            <span />
          )}
          {older && (
            <Link href={`/changelog?page=${page + 1}`} className={buttonVariants({ variant: "outline" })}>
              Older entries
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
