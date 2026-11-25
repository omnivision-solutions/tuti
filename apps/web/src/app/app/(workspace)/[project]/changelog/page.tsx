import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { aiPaused, autopilotLines, onlyPullRequestTitles } from "@tuti/jobs";
import { aiEnabled } from "@tuti/shared";
import { PlusIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { changelogTag } from "@/components/changelog-pages";
import { TAG_LABELS, TagBadge } from "@/components/changelog-tag";
import { EmptyState } from "@/components/empty-state";
import { FilterPills } from "@/components/filter-pills";
import { ItemList, ItemRow } from "@/components/item-list";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { PaneSearch } from "@/components/pane-search";
import { SampleBadge } from "@/components/sample-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDay, formatMonth, formatShortDate } from "@/lib/format";
import { reactionSummary } from "@/lib/reactions";
import { draftToWrite, reactionCounts } from "@/server/changelog-queries";
import { lastingImage } from "@/server/media-urls";
import { getMembership } from "@/server/membership";

export const metadata: Metadata = { title: "Changelog" };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The team's changelog, one list: the drafts (the one whose release notes wait first, then the running draft, then the
 * latest edited), then the published entries by month, newest first. `?q=` searches titles and text, `?tag=` picks a
 * tag (pills with their counts). Old `?tab=` links land here too: the param is ignored.
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
  const [found, total, ready] = await Promise.all([
    prisma.changelogEntry.findMany({
      where: { projectId, ...(q && { OR: [{ title: { contains: q, mode: "insensitive" } }, { body: { contains: q, mode: "insensitive" } }] }) },
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
        // Its posts' statuses, not merged ones (their votes moved; the editor leaves them out): what it completes.
        posts: { where: { post: { duplicateOfId: null } }, select: { post: { select: { status: true } } } },
        _count: { select: { pullRequests: true, comments: true } },
      },
    }),
    q ? prisma.changelogEntry.count({ where: { projectId } }) : null,
    // Release notes waiting to be written: the draft the newest release closed, else the running one with merged pull requests.
    draftToWrite(projectId),
  ]);
  // The tags the search's entries have, as pills with their counts; the list, those with the tag picked.
  const tags = (Object.keys(TAG_LABELS) as (keyof typeof TAG_LABELS)[]).filter((t) => found.some((e) => e.tags.includes(t)));
  const listed = tag ? found.filter((e) => e.tags.includes(tag)) : found;
  const reactions = await reactionCounts(listed.filter((e) => e.publishedAt).map((e) => e.id));
  const first = (e: (typeof listed)[number]) => (e.number === ready?.number ? 2 : e.collecting ? 1 : 0);
  const drafts = listed.filter((e) => !e.publishedAt).sort((a, b) => first(b) - first(a));
  const months = Map.groupBy(
    listed.filter((e) => e.publishedAt),
    (e) => formatMonth(e.publishedAt!),
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

  const row = (entry: (typeof listed)[number]) => {
    const href = `${base}/${entry.number}`;
    const cover = lastingImage(entry.cover)?.url;
    const writeIt = entry.number === ready?.number;
    const date = entry.publishedAt ?? entry.updatedAt;
    // Published: its posts that are completed. A draft: those publishing will complete (as it does, not the Completed or Closed).
    const posts = entry.posts.filter(({ post }) => (entry.publishedAt ? post.status === "COMPLETED" : post.status !== "COMPLETED" && post.status !== "CLOSED")).length;
    return (
      <ItemRow
        key={entry.number}
        // A date column, as the portal's timeline: when it went out, or for a draft when it was last edited.
        leading={
          <time dateTime={date.toISOString()} className="w-14 shrink-0 self-start pt-0.5 text-xs text-muted-foreground tabular-nums">
            <span className="sr-only">{entry.publishedAt ? "Published " : "Edited "}</span>
            {entry.publishedAt ? formatDay(date) : formatShortDate(date)}
          </time>
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
          ...entry.tags.map((t) => <TagBadge key={t} tag={t} />),
        ]}
        // What it holds (a draft) or what readers did with it (published); nothing said when there's none.
        meta={
          [
            !entry.publishedAt && entry._count.pullRequests > 0 && plural(entry._count.pullRequests, "merged pull request"),
            posts > 0 && (entry.publishedAt ? `${plural(posts, "post")} completed` : `Completes ${plural(posts, "post")}`),
            entry.publishedAt && reactionSummary(reactions(entry.id)),
            entry._count.comments > 0 && plural(entry._count.comments, "comment"),
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
        actions={
          (writeIt || cover) && (
            <>
              {cover && (
                // Its featured image, small (the 480px size: sharp at 2×); decorative, the title names the entry.
                // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
                <img src={cover} alt="" loading="lazy" className="aspect-[1200/630] w-19 shrink-0 rounded-md border object-cover @max-[48rem]/app:w-15" />
              )}
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
  const group = (title: string, entries: typeof listed) => (
    <section key={title} aria-label={title} className="flex flex-col gap-2">
      <h2 className="group-label flex items-center gap-2">
        {title}
        <Badge variant="secondary">{entries.length}</Badge>
      </h2>
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
                  count: t ? found.filter((e) => e.tags.includes(t)).length : found.length,
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
              {drafts.length > 0 && group("Drafts", drafts)}
              {[...months].map(([month, entries]) => group(month, entries))}
            </>
          )}
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
