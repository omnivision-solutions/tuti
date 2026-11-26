import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { aiPaused, autopilotLines, onlyPullRequestTitles } from "@tuti/jobs";
import { aiEnabled } from "@tuti/shared";
import { PlusIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { changelogTag } from "@/components/changelog-pages";
import { TAG_LABELS, TAG_VARIANTS } from "@/components/changelog-tag";
import { EmptyState } from "@/components/empty-state";
import { FilterPills } from "@/components/filter-pills";
import { ItemList, ItemRow } from "@/components/item-list";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { PaneSearch } from "@/components/pane-search";
import { SampleBadge } from "@/components/sample-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDay, formatShortDate } from "@/lib/format";
import { REACTIONS } from "@/lib/reactions";
import { draftToWrite, reactionCounts } from "@/server/changelog-queries";
import { lastingImage } from "@/server/media-urls";
import { getMembership } from "@/server/membership";

export const metadata: Metadata = { title: "Changelog" };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The team's changelog, one list: the drafts (the one whose release notes wait first, then the running draft, then the
 * latest edited), then the published entries by year, newest first, each a line: its cover, title, date and tags, and
 * how many reactions it had. `?q=` searches titles and text, `?tag=` picks a
 * tag (pills, no counts: most entries have most tags). Old `?tab=` links land here too: the param is ignored.
 */
export default async function TeamChangelogPage(props: PageProps<"/app/[project]/changelog">) {
  const { project: slug } = await props.params;
  const params = await props.searchParams;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const q = (typeof params.q === "string" ? params.q : undefined)?.trim().slice(0, 255) || undefined;
  const tag = changelogTag(params.tag);
  const projectId = membership.project.id;
  // The search as words, as the app's other searches take it: its % and _ aren't patterns.
  const has = q && { contains: q.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" as const };
  const [found, total, ready] = await Promise.all([
    prisma.changelogEntry.findMany({
      where: { projectId, ...(has && { OR: [{ title: has }, { body: has }] }) },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { updatedAt: "desc" }],
      select: {
        id: true,
        number: true,
        title: true,
        tags: true,
        publishedAt: true,
        collecting: true,
        releasedAt: true,
        sample: true,
        updatedAt: true,
        cover: { select: { id: true, status: true, width: true, height: true } },
        // Its posts as its editor lists them (not merged ones: their votes moved to the post they were merged into).
        _count: { select: { posts: { where: { post: { duplicateOfId: null } } }, pullRequests: true, comments: true } },
      },
    }),
    q ? prisma.changelogEntry.count({ where: { projectId } }) : null,
    // Release notes waiting to be written: the draft the newest release closed, else the running one with merged pull requests.
    draftToWrite(projectId),
  ]);
  // The tags the search's entries have (and the one picked, even with none), as pills; the list, those with the tag picked.
  const tags = (Object.keys(TAG_LABELS) as (keyof typeof TAG_LABELS)[]).filter((t) => t === tag || found.some((e) => e.tags.includes(t)));
  const listed = tag ? found.filter((e) => e.tags.includes(tag)) : found;
  const reactions = await reactionCounts(listed.filter((e) => e.publishedAt).map((e) => e.id));
  const first = (e: (typeof listed)[number]) => (e.number === ready?.number ? 2 : e.collecting ? 1 : 0);
  const drafts = listed.filter((e) => !e.publishedAt).sort((a, b) => first(b) - first(a));
  const years = Map.groupBy(
    listed.filter((e) => e.publishedAt),
    (e) => String(e.publishedAt!.getUTCFullYear()),
  );
  // Draft with AI is the way into the draft whose notes wait while AI can run and its text is still its pull requests'
  // titles or Autopilot's lines (as its editor decides, where Draft with AI then leads); Write it otherwise (and if it
  // was deleted since draftToWrite read it).
  const draftWithAi =
    ready &&
    aiEnabled() &&
    !(await aiPaused(projectId)) &&
    (await prisma.changelogEntry
      .findUnique({
        where: { projectId_number: { projectId, number: ready.number } },
        select: { content: true, pullRequests: { select: { repo: true, number: true, title: true, url: true } } },
      })
      .then(async (draft) => draft !== null && onlyPullRequestTitles(draft.content, draft.pullRequests, await autopilotLines(projectId, draft.pullRequests.map((pr) => pr.url)))));
  const base = `/app/${slug}/changelog`;
  const view = (t: typeof tag, search: string | undefined) => {
    const query = new URLSearchParams({ ...(search && { q: search }), ...(t && { tag: t.toLowerCase() }) }).toString();
    return query ? `${base}?${query}` : base;
  };
  const newEntry = (
    // A round + on phones.
    <Link href={`${base}/new`} className={buttonVariants({ size: "sm", className: "@max-[48rem]/app:size-8 @max-[48rem]/app:px-0" })}>
      <PlusIcon aria-hidden />
      <span className="@max-[48rem]/app:sr-only">New entry</span>
    </Link>
  );

  // Covers' places kept only where some entry has one (titles line up); with none, no empty boxes.
  const anyCover = listed.some((e) => lastingImage(e.cover));
  const row = (entry: (typeof listed)[number]) => {
    const href = `${base}/${entry.number}`;
    const cover = lastingImage(entry.cover)?.url;
    const writeIt = entry.number === ready?.number;
    const date = entry.publishedAt ?? entry.updatedAt;
    const reacted = entry.publishedAt ? REACTIONS.reduce((sum, r) => sum + reactions(entry.id)[r], 0) : 0;
    return (
      <ItemRow
        key={entry.number}
        // Its featured image (the 480px size: sharp at 2×), or its place kept, so the titles line up; decorative, the
        // title names the entry.
        leading={
          !anyCover ? undefined : cover ? (
            // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
            <img src={cover} alt="" loading="lazy" className="aspect-[1200/630] w-21 shrink-0 self-start rounded-md border object-cover @max-[48rem]/app:w-15" />
          ) : (
            <span aria-hidden className="aspect-[1200/630] w-21 shrink-0 self-start rounded-md border border-dashed bg-muted/40 @max-[48rem]/app:w-15" />
          )
        }
        title={
          <Link href={href} className="hover:underline">
            {entry.title}
          </Link>
        }
        badges={[
          ...(entry.sample ? [<SampleBadge key="sample" />] : []),
          ...(entry.collecting ? [<Badge key="collecting" variant="outline">Collecting pull requests</Badge>] : []),
          ...(!entry.publishedAt && entry.releasedAt ? [<Badge key="released" variant="outline">Released</Badge>] : []),
        ]}
        // One quiet line: when it went out (a draft, when it was last edited), its tags, what it holds or completes, and
        // what readers said; nothing said when there's none.
        meta={[
          <time key="date" dateTime={date.toISOString()} className="tabular-nums">
            <span className="sr-only">{entry.publishedAt ? "Published " : "Edited "}</span>
            {entry.publishedAt ? formatDay(date) : formatShortDate(date)}
          </time>,
          // Its tags as words, Breaking in the destructive colour (TAG_VARIANTS), as its chip elsewhere.
          ...(entry.tags.length > 0
            ? [
                <span key="tags">
                  {" · "}
                  {entry.tags.map((t, i) => (
                    <span key={t}>
                      {i > 0 && ", "}
                      <span className={TAG_VARIANTS[t] === "destructive" ? "text-destructive-foreground" : undefined}>{TAG_LABELS[t]}</span>
                    </span>
                  ))}
                </span>,
              ]
            : []),
          ...[
            !entry.publishedAt && entry._count.pullRequests > 0 && plural(entry._count.pullRequests, "merged pull request"),
            entry._count.posts > 0 && plural(entry._count.posts, "post"),
            entry._count.comments > 0 && plural(entry._count.comments, "comment"),
          ]
            .filter(Boolean)
            .map((part) => <span key={String(part)}> · {part}</span>),
        ]}
        actions={
          (writeIt || reacted > 0) && (
            <>
              {reacted > 0 && <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{plural(reacted, "reaction")}</span>}
              {writeIt && (
                // Its release notes wait: its editor. Draft with AI round on phones.
                <Link href={href} className={buttonVariants({ variant: "outline", size: "sm", className: draftWithAi ? "@max-[48rem]/app:size-8 @max-[48rem]/app:px-0" : undefined })}>
                  {draftWithAi && <SparklesIcon aria-hidden />}
                  <span className={draftWithAi ? "@max-[48rem]/app:sr-only" : undefined}>{draftWithAi ? "Draft with AI" : "Write it"}</span>
                </Link>
              )}
            </>
          )
        }
      />
    );
  };
  // A year's entries under its name; the drafts in a dashed panel of their own, above them.
  const group = (title: string, entries: typeof listed, drafts = false) => (
    <section key={title} aria-label={title} className={drafts ? "flex flex-col gap-3 rounded-lg border border-dashed p-3" : "flex flex-col gap-2"}>
      <h2 className="group-label">{title}</h2>
      <ItemList>{entries.map(row)}</ItemList>
    </section>
  );

  return (
    <PaneLayout>
      <Pane aria-label="Changelog">
        <PaneHeader
          title="Changelog"
          description="What you shipped, for your users to read."
          filters={
            tags.length > 0 && (
              <FilterPills
                label="Tags"
                current={view(tag, q)}
                items={[undefined, ...tags].map((t) => ({
                  href: view(t, q),
                  title: t ? TAG_LABELS[t] : "All",
                }))}
              />
            )
          }
          actions={
            <>
              <PaneSearch action={base} q={q} label="Search the changelog">
                {tag && <input type="hidden" name="tag" value={tag.toLowerCase()} />}
              </PaneSearch>
              {/* Searching doesn't load a new page, so a screen reader hears what it found here (polite, there from the start). */}
              <p role="status" className="sr-only">
                {q ? `Search for “${q}” found ${listed.length === 0 ? "no entries" : plural(listed.length, "entry", "entries")}` : ""}
              </p>
              {newEntry}
            </>
          }
        />
        <PaneBody resetOnNavigate className="flex flex-col gap-6 p-4 @min-[48rem]/app:px-5">
          {listed.length === 0 ? (
            (total ?? found.length) === 0 ? (
              <EmptyState
                title="No entries yet"
                description="Write what shipped and pick the posts it completes."
                action={
                  // Outline: the header's New entry is the page's primary.
                  <Link href={`${base}/new`} className={buttonVariants({ variant: "outline" })}>
                    Write the first entry
                  </Link>
                }
              />
            ) : (
              <EmptyState
                title={q ? "No entries match your search" : "No entries match"}
                description="Try other words, or another tag."
                // The search taken off, the tag kept; or, with no search, the tag (no pills to pick another: none has it).
                action={
                  <Link href={view(q ? tag : undefined, undefined)} className={buttonVariants({ variant: "outline" })}>
                    {q ? "Clear search" : "Show all entries"}
                  </Link>
                }
              />
            )
          ) : (
            <>
              {drafts.length > 0 && group("Drafts", drafts, true)}
              {[...years].map(([year, entries]) => group(year, entries))}
            </>
          )}
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
