import type { ChangelogTag } from "@tuti/db";
import { RssIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChangelogEntryView, TAG_LABELS } from "@/components/changelog-entry";
import { ChangelogSeen } from "@/components/changelog-seen";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { portalAddress } from "@/server/custom-domains";
import { Separator } from "@/components/ui/separator";
import { PortalMenuPart } from "@/components/portal-menu";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { changelogContents, changelogDates, publishedEntries } from "@/server/changelog-queries";
import { latestAnnouncedAt } from "@/server/operations/changelog-seen";
import { getSession } from "@/server/session";
import { portalBase, portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";

const PAGE_SIZE = 20;

/** More entries than a screen shows: the list gets a month index beside it to jump through them. */
const MONTH_INDEX_FROM = 9;

/** A changelog page's path: /changelog, then /changelog/page/2 and on; `?tag=new` with a tag's chip picked. */
export const changelogPath = (page: number, tag?: ChangelogTag) =>
  `${page === 1 ? "/changelog" : `/changelog/page/${page}`}${tag ? `?tag=${tag.toLowerCase()}` : ""}`;

/** The tag `?tag=` names ("new", "improved", "fixed", "breaking"); anything else is none. */
export function changelogTag(param: string | string[] | undefined): ChangelogTag | undefined {
  return (Object.keys(TAG_LABELS) as ChangelogTag[]).find((tag) => tag.toLowerCase() === param);
}

/** "October 2026" (UTC, as `formatDate`); its key "2026-10" is the anchor of its first entry on the list. */
const monthOf = (date: Date) => ({
  key: date.toISOString().slice(0, 7),
  label: date.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
});

/**
 * On a changelog page, the header's menu (on phones and tablets) lists the newest entries by date,
 * each with its title, `current` (an entry's number, on its page) marked; then all of them.
 */
export async function ChangelogMenu({ slug, current }: { slug: string; current?: number }) {
  const [at, entries] = await Promise.all([portalLinks(), changelogContents(slug)]);
  if (entries.length === 0) {
    return null;
  }
  return (
    <PortalMenuPart>
      <nav aria-label="Changelog entries" className="flex flex-col gap-0.5 text-sm">
        <Link href={at("/changelog")} className="px-2 py-1 font-heading font-semibold">
          Changelog
        </Link>
        {entries.map((entry) => {
          const active = entry.number === current;
          return (
            <Link
              key={entry.number}
              href={at(`/changelog/${entry.number}`)}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col rounded-md px-2 py-1.5 ${active ? "bg-accent" : "hover:bg-accent/50"}`}
            >
              <time dateTime={entry.publishedAt!.toISOString()} className={active ? "font-medium" : "text-muted-foreground"}>
                {formatDate(entry.publishedAt!)}
              </time>
              <span className="text-xs break-words text-muted-foreground">{entry.title}</span>
            </Link>
          );
        })}
      </nav>
    </PortalMenuPart>
  );
}

/** Feed readers find the RSS feed from the page: a full URL on the project's portal. */
export async function changelogMetadata(slug: string): Promise<Metadata> {
  return {
    alternates: { types: { "application/rss+xml": [{ url: `${await portalAddress(slug)}/changelog/rss.xml`, title: "Changelog" }] } },
  };
}

/**
 * What shipped, newest first, a page at a time (/changelog, then /changelog/page/2 for older ones); with `tag`
 * (its chip, `?tag=`) only the entries with it. Past the last page it's a 404: a function the pages call, not a
 * component, so that happens before they render.
 */
export async function changelogPage(slug: string, page: number, tag?: ChangelogTag) {
  const at = await portalLinks();
  const base = await portalBase();
  // One more than a page, to know whether there are older ones.
  const session = await getSession();
  const [found, announced, dates] = await Promise.all([
    publishedEntries(slug, { tag, take: PAGE_SIZE + 1, skip: (page - 1) * PAGE_SIZE, userId: session?.user.id }),
    // The newest entries are on the first page: viewing it, a signed-in user has seen them (the nav's "New" goes).
    session && page === 1 && !tag ? latestAnnouncedAt({ slug }) : null,
    changelogDates(slug),
  ]);
  const entries = found.slice(0, PAGE_SIZE);
  if (entries.length === 0 && page > 1) {
    notFound();
  }
  const older = found.length > PAGE_SIZE;
  const media = await mediaUrls(...entries.flatMap((entry) => [entry.doc, entry.cover]));
  // A chip for each tag some entry has, in the editor's order.
  const tags = (Object.keys(TAG_LABELS) as ChangelogTag[]).filter((t) => dates.some((entry) => entry.tags.includes(t)));
  // The month index: each month the (picked) entries span, how many, and the page its newest one is on.
  const listed = tag ? dates.filter((entry) => entry.tags.includes(tag)) : dates;
  const months = new Map<string, { label: string; count: number; page: number }>();
  listed.forEach((entry, i) => {
    const { key, label } = monthOf(entry.publishedAt!);
    const month = months.get(key) ?? months.set(key, { label, count: 0, page: Math.floor(i / PAGE_SIZE) + 1 }).get(key)!;
    month.count++;
  });
  // The anchors: each month's first entry on this page.
  const anchors = new Map(entries.map((entry) => [monthOf(entry.publishedAt).key, entry.number] as const).reverse());
  return (
    // On wide screens the month index is in a column beside the list (empty with a short history, so entries keep their width).
    <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_11rem] lg:items-start lg:gap-12">
      <div className="flex min-w-0 flex-col gap-8">
        <ChangelogMenu slug={slug} />
        {announced && <ChangelogSeen projectSlug={slug} at={announced.toISOString()} signedIn />}
        {/* The tags' chips go with the header, closer to it than the list. */}
        <div className="flex flex-col gap-4">
          <PageHeader
            title="Changelog"
            description="What's new, improved and fixed."
            actions={
              <a href={at("/changelog/rss.xml")} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                <RssIcon aria-hidden /> RSS
              </a>
            }
          />
          {tags.length > 0 && (
            // Server-rendered links, so a picked tag is an address to share; picking one starts from the first page.
            <nav aria-label="Tags" className="flex flex-wrap gap-2">
              {[undefined, ...tags].map((t) => (
                <Link
                  key={t ?? "all"}
                  href={at(changelogPath(1, t))}
                  aria-current={t === tag ? "page" : undefined}
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm transition-colors",
                    t === tag ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {t ? TAG_LABELS[t] : "All"}
                </Link>
              ))}
            </nav>
          )}
        </div>
        {entries.length === 0 ? (
          tag ? (
            <EmptyState
              title={`No ${TAG_LABELS[tag]} entries yet`}
              description="Entries with this tag show up here as they ship."
              action={
                <Link href={at(changelogPath(1))} className={buttonVariants({ variant: "outline" })}>
                  Show all entries
                </Link>
              }
            />
          ) : (
            <EmptyState title="Nothing here yet" description="New features and fixes show up here as they ship." />
          )
        ) : (
          entries.map((entry, i) => (
            <div
              key={entry.number}
              id={anchors.get(monthOf(entry.publishedAt).key) === entry.number ? monthOf(entry.publishedAt).key : undefined}
              className="flex flex-col gap-8"
            >
              {i > 0 && <Separator />}
              <ChangelogEntryView entry={entry} mediaUrls={media} react={{ projectSlug: slug, signedIn: !!session }} base={base} dateMargin />
            </div>
          ))
        )}
        {(older || page > 1) && (
          <nav aria-label="Changelog pages" className="flex justify-between gap-4">
            {page > 1 ? (
              <Link href={at(changelogPath(page - 1, tag))} className={buttonVariants({ variant: "outline" })}>
                Newer entries
              </Link>
            ) : (
              <span />
            )}
            {older && (
              <Link href={at(changelogPath(page + 1, tag))} className={buttonVariants({ variant: "outline" })}>
                Older entries
              </Link>
            )}
          </nav>
        )}
      </div>
      {/* Nothing new on phones: the header's menu lists the entries by date (ChangelogMenu). */}
      {listed.length >= MONTH_INDEX_FROM && (
        <nav
          aria-label="Months"
          className="hidden max-h-[calc(100dvh-var(--portal-header-height,0px)-5rem)] overflow-y-auto lg:sticky lg:top-[calc(var(--portal-header-height,0px)+2.5rem)] lg:flex lg:flex-col"
        >
          <h2 className="mb-2 px-2 text-sm font-medium">Months</h2>
          {[...months].map(([key, month]) => (
            <Link
              key={key}
              href={`${at(changelogPath(month.page, tag))}#${key}`}
              // Read out as "October 2026, 3 entries", not "October 20263".
              aria-label={`${month.label}, ${month.count} ${month.count === 1 ? "entry" : "entries"}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="min-w-0 flex-1">{month.label}</span>
              <span className="text-xs tabular-nums">{month.count}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
