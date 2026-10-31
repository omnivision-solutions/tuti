import { prisma } from "@tuti/db";
import { LayoutListIcon, MapIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { FeedbackKeys } from "@/components/feedback-keys";
import { FeedbackPane } from "@/components/feedback-pane";
import { FeedbackBulk, FeedbackSelection, SelectPost } from "@/components/feedback-selection";
import { ItemList, ItemRow } from "@/components/item-list";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { PostStatusMenu } from "@/components/post-status-select";
import { SubNav } from "@/components/sub-nav";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { asking } from "@/lib/format";
import { cn } from "@/lib/utils";
import { storedConditions } from "@/lib/group-conditions";
import { sortFilter } from "@/lib/post-filter-options";
import { nextPageHref, parsePostFilters, STATUS_PARAMS, TEAM_SORTS } from "@/lib/post-filters";
import { teamPostCounts, teamPosts, voterTotals } from "@/server/post-lists";

/** Feedback's tabs by status, opening on the posts nobody has triaged; then All and the possible duplicates. */
const TABS = [
  ["open", "Needs triage"],
  ["under-review", "Under review"],
  ["planned", "Planned"],
  ["in-progress", "In progress"],
  ["completed", "Done"],
] as const;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function FeedbackPage(props: PageProps<"/app/[project]/feedback">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const duplicatesOnly = first(searchParams.show) === "duplicates";
  // No status: Needs triage; one without a tab (Closed, say): All. The duplicates tab: every status.
  const status = first(searchParams.status) ?? "open";
  const tab = duplicatesOnly ? "duplicates" : TABS.some(([key]) => key === status) ? status : "all";
  const filters = parsePostFilters({ ...searchParams, status: duplicatesOnly ? "all" : tab }, TEAM_SORTS);
  const q = first(searchParams.q)?.trim().slice(0, 255) || undefined;
  const project = await prisma.project.findUniqueOrThrow({
    where: { slug },
    select: {
      id: true,
      askingProperty: true,
      boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } },
      readerGroups: { orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true, conditions: true } },
    },
  });
  const board = project.boards.some((b) => b.slug === filters.board) ? filters.board : undefined;
  // Who's asking: the posts a reader group voted for.
  const group = project.readerGroups.find((g) => g.key === first(searchParams.group));
  const scope = { board, q, group: group && storedConditions(group.conditions) };
  const [{ posts, more }, counts] = await Promise.all([teamPosts(project.id, filters, { ...scope, duplicatesOnly }), teamPostCounts(project.id, scope)]);
  const totals = await voterTotals(project.id, project.askingProperty, posts.map((post) => post.id));

  // The post open in the pane (`?post=<number>`), and the list's links with another one open, or none.
  const opened = Number(first(searchParams.post));
  const open = Number.isInteger(opened) && opened > 0 ? opened : null;
  const withPost = (number: number | null) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      const one = first(value);
      if (key !== "post" && one !== undefined) {
        params.set(key, one);
      }
    }
    if (number !== null) {
      params.set("post", String(number));
    }
    return params.size > 0 ? `/app/${slug}/feedback?${params}` : `/app/${slug}/feedback`;
  };
  // The list, whatever's open in the pane or however much is loaded: picked rows are for it, and go with it.
  const listKey = new URLSearchParams(Object.entries(searchParams).flatMap(([key, value]) => (key === "post" || key === "page" || first(value) === undefined ? [] : [[key, first(value)!]])));
  listKey.sort();

  // A tab keeps the board, the search and the sort.
  const href = (to: string) => {
    const params = new URLSearchParams({
      ...(board && { board }),
      ...(group && { group: group.key }),
      ...(q && { q }),
      ...(filters.sort !== "top" && { sort: filters.sort }),
      ...(to === "duplicates" ? { show: "duplicates" } : to !== "open" && { status: to }),
    });
    return params.size > 0 ? `/app/${slug}/feedback?${params}` : `/app/${slug}/feedback`;
  };
  const tabs = [
    ...TABS.map(([key, title]) => ({ key, title, count: counts.of(STATUS_PARAMS[key]!) })),
    { key: "all", title: "All", count: counts.all },
    { key: "duplicates", title: "Possible duplicates", count: counts.duplicates },
  ];

  return (
    <>
      <PageHeader
        title="Feedback"
        actions={
          <>
            <form role="search" className="flex w-full min-w-0 sm:w-56 lg:w-72">
              {board && <input type="hidden" name="board" value={board} />}
              {group && <input type="hidden" name="group" value={group.key} />}
              {filters.sort !== "top" && <input type="hidden" name="sort" value={filters.sort} />}
              {duplicatesOnly ? <input type="hidden" name="show" value="duplicates" /> : tab !== "open" && <input type="hidden" name="status" value={tab} />}
              <Input type="search" name="q" defaultValue={q} placeholder="Search titles and descriptions" aria-label="Search feedback" className="h-8" />
            </form>
            <Link href={`/app/${slug}/feedback/roadmap`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <MapIcon />
              Roadmap
            </Link>
            <Link href={`/app/${slug}/feedback/boards`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <LayoutListIcon />
              Boards
            </Link>
          </>
        }
      />

      <FeedbackKeys order={posts.map((post) => post.number)} open={open} base={withPost(null)} />
      {/* The list and, beside it, the post a row opened (the whole width); on a phone, one or the other. */}
      <div data-slot="pane-layout" className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:items-start">
        {/* Rows picked for Set status, Move to board and Merge, the bar over the list once some are. */}
        <FeedbackSelection key={listKey.toString()} listed={posts.map((post) => post.id)}>
          <div className={cn("flex min-w-0 flex-col gap-4", open !== null && "max-lg:hidden")}>
            <SubNav
              label="Statuses"
              current={href(tab)}
              items={tabs.map((t) => ({
                href: href(t.key),
                title: (
                  <>
                    {t.title} <span className="text-muted-foreground tabular-nums">{t.count}</span>
                  </>
                ),
              }))}
            />

            <ListFilters
              filters={[
                {
                  name: "board",
                  label: "Board",
                  value: board ?? "all",
                  options: [{ value: "all", label: "All boards" }, ...project.boards.map((b) => ({ value: b.slug, label: b.name }))],
                },
                ...(project.readerGroups.length > 0
                  ? [
                      {
                        name: "group",
                        label: "Voters",
                        // "*" can't be a group's key (a group named "All" has "all").
                        value: group?.key ?? "*",
                        options: [{ value: "*", label: "Everyone" }, ...project.readerGroups.map((g) => ({ value: g.key, label: `Voted by ${g.name}` }))],
                      },
                    ]
                  : []),
                sortFilter(filters.sort, TEAM_SORTS),
              ]}
            />

            <FeedbackBulk projectSlug={slug} boards={project.boards} />
            {posts.length === 0 ? (
              counts.all === 0 && !q && !board && !group ? (
                <EmptyState title="No feedback yet" description="Share your portal with users, or connect your app with single sign-on in Settings." />
              ) : (
                <EmptyState
                  title={q || board || group ? "No posts match" : tab === "open" ? "Nothing to triage" : tab === "duplicates" ? "No possible duplicates" : "No posts here"}
                  description={
                    q || board || group
                      ? "Try other words, or another board or tab."
                      : tab === "duplicates"
                        ? "Posts that may repeat an older one show here."
                        : "Posts show here when they have this status."
                  }
                />
              )
            ) : (
              <Card size="sm">
                <CardContent>
                  <ItemList>
                    {posts.map((post) => (
                      <ItemRow
                        key={post.id}
                        className={cn(post.number === open && "-mx-2 rounded-md bg-muted px-2")}
                        leading={
                          <>
                            <SelectPost post={{ id: post.id, number: post.number, title: post.title, voteCount: post.voteCount }} />
                            <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{post.voteCount}</span>
                          </>
                        }
                        title={
                          <Link href={withPost(post.number)} scroll={false} aria-current={post.number === open ? "true" : undefined} className="hover:underline">
                            {post.title}
                          </Link>
                        }
                        badges={
                          post._count.duplicateSuggestions > 0 && <Badge variant="highlight">Possible duplicate</Badge>
                        }
                        meta={
                          <>
                            #{post.number} · {post.board.name} · {post.author.name}
                            {post.commentCount > 0 &&
                              ` · ${post.commentCount} ${post.commentCount === 1 ? "comment" : "comments"}`}
                            {totals.has(post.id) && ` · ${asking(totals.get(post.id)!, project.askingProperty!)}`}
                          </>
                        }
                        actions={<PostStatusMenu projectSlug={slug} postId={post.id} status={post.status} />}
                      />
                    ))}
                  </ItemList>
                </CardContent>
              </Card>
            )}
            {more && (
              <Link
                href={nextPageHref(searchParams, filters)}
                scroll={false}
                className={buttonVariants({ variant: "outline", className: "self-center" })}
              >
                Load more
              </Link>
            )}
          </div>
        </FeedbackSelection>
        {/* Keyed by the post: each one starts at the top of the pane (scrolling on its own), wherever the last was. */}
        <aside
          key={open ?? "none"}
          aria-label="Post"
          className={cn(
            "lg:sticky lg:top-18 lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:border-l lg:pl-6",
            open === null && "max-lg:hidden",
          )}
        >
          {open !== null ? (
            <FeedbackPane projectSlug={slug} projectId={project.id} askingProperty={project.askingProperty} number={open} close={withPost(null)} />
          ) : (
            <p className="text-sm text-muted-foreground">Open a post to triage it here: click its title, or press J.</p>
          )}
        </aside>
      </div>
    </>
  );
}
