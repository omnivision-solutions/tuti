import { prisma } from "@tuti/db";
import { seenAs } from "@tuti/jobs";
import { ExternalLinkIcon, LayoutListIcon, MessageSquareIcon, PlusIcon, SearchIcon } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { FeedbackKeys } from "@/components/feedback-keys";
import { FeedbackPane } from "@/components/feedback-pane";
import { FeedbackBulk, FeedbackSelection, FiltersFold, PickedRow, SelectPost, VoteBox } from "@/components/feedback-selection";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { PostStatusMenu } from "@/components/post-status-select";
import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { SubNav } from "@/components/sub-nav";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SampleBadge } from "@/components/sample-badge";
import { asking, initial, timeAgo } from "@/lib/format";
import { storedPropertyFormats } from "@/lib/property-formats";
import { cn } from "@/lib/utils";
import { storedRule } from "@/lib/group-conditions";
import { sortFilter } from "@/lib/post-filter-options";
import { nextPageHref, parsePostFilters, STATUS_PARAMS, TEAM_SORTS } from "@/lib/post-filters";
import { portalAddress } from "@/server/custom-domains";
import { getMembership } from "@/server/membership";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { teamPostCounts, teamPosts, voterTotals } from "@/server/post-lists";
import { VisibilityBadge } from "@/components/visibility-badge";

/** Feedback's tabs by status, opening on the posts nobody has triaged; then All and the possible duplicates. */
/** The statuses in the order the tabs (and All's groups) take them. */
const STATUS_ORDER = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "CLOSED"] as const;

const TABS = [
  ["open", "Needs triage"],
  ["under-review", "Under review"],
  ["planned", "Planned"],
  ["in-progress", "In progress"],
  ["completed", "Completed"],
] as const;

/** How many status tabs fit beside an open post; the others are under More. */
const BESIDE_POST = 3;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function FeedbackPage(props: PageProps<"/app/[project]/feedback">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const searchParams = await props.searchParams;
  const duplicatesOnly = first(searchParams.show) === "duplicates";
  // No status: Needs triage; one without a tab (Closed, say): All. The duplicates tab: every status.
  const status = first(searchParams.status) ?? "open";
  const tab = duplicatesOnly ? "duplicates" : TABS.some(([key]) => key === status) ? status : "all";
  const filters = parsePostFilters({ ...searchParams, status: duplicatesOnly ? "all" : tab }, TEAM_SORTS);
  const q = first(searchParams.q)?.trim().slice(0, 255) || undefined;
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: membership.project.id },
    select: {
      id: true,
      askingProperty: true,
      propertyFormats: true,
      boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } },
      readerGroups: { orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true, conditions: true, match: true } },
    },
  });
  const board = project.boards.some((b) => b.slug === filters.board) ? filters.board : undefined;
  const formats = storedPropertyFormats(project.propertyFormats);
  // Who's asking: the posts a reader group voted for.
  const group = project.readerGroups.find((g) => g.key === first(searchParams.group));
  const scope = { board, q, group: group && storedRule(group) };
  const [{ posts, more }, counts] = await Promise.all([teamPosts(project.id, filters, { ...scope, duplicatesOnly }), teamPostCounts(project.id, scope)]);
  // Who's asking, and how many completing each one emails (asked first, from its row or picked with others).
  const [totals, emails] = await Promise.all([
    voterTotals(project.id, project.askingProperty, posts.map((post) => post.id)),
    emailedOnCompletion(project.id, posts.map((post) => post.id)),
  ]);
  // What completing it now emails: nobody, if it's completed already (picked with others, say).
  const emailing = (post: (typeof posts)[number]) => (post.status === "COMPLETED" ? 0 : (emails.get(post.id) ?? 0));

  // All, when it mixes statuses: the posts grouped by status in the tabs' order, each group most voted first (as listed);
  // only once it's all loaded, so each group's count is all of them and Load more doesn't add rows to groups above it.
  const statuses = [...new Set(posts.map((post) => post.status))];
  const groups =
    tab === "all" && statuses.length > 1 && !more
      ? STATUS_ORDER.filter((status) => statuses.includes(status)).map((status) => ({ status, posts: posts.filter((post) => post.status === status) }))
      : [{ status: null, posts }];
  const listed = groups.flatMap((group) => group.posts);
  // The status pill on each row wherever no tab or group heading names the status: Possible duplicates, and All while
  // it isn't grouped (one status, or more to load).
  const mixedUngrouped = (tab === "all" || tab === "duplicates") && groups[0]?.status == null;

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
  // This tab and its filters, the search taken off.
  const kept = new URLSearchParams(href(tab).split("?")[1] ?? "");
  kept.delete("q");
  const withoutSearch = kept.size > 0 ? `/app/${slug}/feedback?${kept}` : `/app/${slug}/feedback`;
  const tabs = [
    ...TABS.map(([key, title]) => ({ key, title, count: counts.of(STATUS_PARAMS[key]!) })),
    { key: "all", title: "All", count: counts.all },
    // Only when there are some (or it's the one open).
    ...(counts.duplicates > 0 || tab === "duplicates" ? [{ key: "duplicates", title: "Possible duplicates", count: counts.duplicates }] : []),
  ];

  const tabItem = (t: (typeof tabs)[number]) => ({
    href: href(t.key),
    title: (
      <>
        {t.title} <span className="text-muted-foreground tabular-nums">{t.count}</span>
      </>
    ),
  });

  return (
    // The list by itself: rows no wider than 72rem, so a title and its votes stay close on a wide screen; a post open
    // beside it, the whole width. Keep the shell's left edge in both views so the clicked row stays put.
    // The page's width (not the list's, which narrows as a post opens) decides whether the toolbar is one row: the same
    // with or without a post open, so the list never moves as one opens.
    <div className={cn("@container/page flex flex-col gap-6", open === null && "w-full max-w-[72rem]")}>
      <PageHeader
        title="Feedback"
        // On phones the list comes up sooner without it.
        description={<span className="max-sm:hidden">Ideas and problems your users posted, by status.</span>}
        // The roadmap is in the sidebar; the boards, used less, in the "…" menu.
        more={
          <Link href={`/app/${slug}/feedback/boards`} className={buttonVariants({ variant: "ghost" })}>
            <LayoutListIcon />
            Boards
          </Link>
        }
        actions={
          // Posts are written on the portal, where users write theirs (as ⌘K's New post). Not primary beside an open post's own.
          <a
            href={`${await portalAddress(slug)}/feedback`}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: open === null ? "default" : "outline" })}
          >
            <PlusIcon />
            New post
            <span className="sr-only"> (on your portal)</span>
          </a>
        }
      />

      <FeedbackKeys order={listed.map((post) => post.number)} open={open} base={withPost(null)} />
      {/* The list (its whole column until a post opens) and, beside it, the post a row opened; on a phone, one or the other. */}
      <div data-slot="pane-layout" className={cn("flex flex-col gap-6", open !== null && "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:items-start")}>
        {/* Rows picked for Set status, Move to board and Merge, the bar in the filters' place once some are. */}
        <FeedbackSelection listKey={listKey.toString()} listed={listed.map((post) => ({ id: post.id, number: post.number, title: post.title, voteCount: post.voteCount, emails: emailing(post), sample: post.sample, visibility: seenAs(post), authorId: post.authorId }))}>
          <div className={cn("@container flex min-w-0 flex-col gap-4", open !== null && "max-lg:hidden")}>
            {/* One row above the list on a page 64rem wide or more, whether or not a post is open beside it (then three
                statuses and More, a narrower search and Filters as its icon): the status tabs (scrolling sideways when they're short of room),
                then the search and Filters; the bar for picked rows in the whole row's place. On phones the tabs above them. */}
            <FeedbackBulk projectSlug={slug} boards={project.boards}>
              <div className="flex flex-col gap-3 @min-[64rem]/page:flex-row @min-[64rem]/page:items-end @min-[64rem]/page:gap-4 @min-[64rem]/page:shadow-[inset_0_-1px_0_var(--color-border)]">
                <SubNav
                  label="Statuses"
                  current={href(tab)}
                  className="min-w-0 @min-[64rem]/page:mt-0 @min-[64rem]/page:flex-1 @min-[64rem]/page:shadow-none"
                  items={(open === null ? tabs : tabs.slice(0, BESIDE_POST)).map(tabItem)}
                  // Beside an open post the list's column is narrower: the first statuses as tabs, the rest under More
                  // (which reads as the one of them open), so the row fits and Needs triage stays in sight.
                  more={open === null ? undefined : { label: "More", items: tabs.slice(BESIDE_POST).map(tabItem) }}
                />
                <div className="min-w-0 @min-[64rem]/page:shrink-0 @min-[64rem]/page:pb-1.5">
                  <div className="flex min-w-0 gap-2">
                    <Form action={`/app/${slug}/feedback`} scroll={false} role="search" className={cn("relative flex min-w-0 flex-1 @min-[64rem]/page:flex-none", open === null ? "@min-[64rem]/page:w-60" : "@min-[64rem]/page:w-40")}>
                      {board && <input type="hidden" name="board" value={board} />}
                      {group && <input type="hidden" name="group" value={group.key} />}
                      {filters.sort !== "top" && <input type="hidden" name="sort" value={filters.sort} />}
                      {duplicatesOnly ? <input type="hidden" name="show" value="duplicates" /> : tab !== "open" && <input type="hidden" name="status" value={tab} />}
                      <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input key={q ?? ""} type="search" name="q" defaultValue={q} placeholder={open === null ? "Search feedback" : "Search"} aria-label="Search feedback" className="h-9 pl-8" />
                    </Form>
                    <FiltersFold compact={open !== null} set={[board, group, filters.sort !== "top" && filters.sort].filter(Boolean).length}>
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
                                  options: [{ value: "*", label: "All voters" }, ...project.readerGroups.map((g) => ({ value: g.key, label: `Voted by ${g.name}` }))],
                                },
                              ]
                            : []),
                          sortFilter(filters.sort, TEAM_SORTS),
                        ]}
                      />
                    </FiltersFold>
                    {/* On phones, where the header's actions are a menu: New post in sight. */}
                    <a
                      href={`${await portalAddress(slug)}/feedback`}
                      target="_blank"
                      rel="noreferrer"
                      title="New post"
                      className={buttonVariants({ className: "sm:hidden" })}
                    >
                      <PlusIcon />
                      New
                      <span className="sr-only"> post (on your portal)</span>
                    </a>
                  </div>
                </div>
              </div>
            </FeedbackBulk>
            {posts.length === 0 ? (
              counts.all === 0 && !q && !board && !group ? (
                <EmptyState
                  title="No feedback yet"
                  description="Share your portal with users, or connect your app with single sign-on in Settings."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <CopyButton value={await portalAddress(slug)} label="portal link" wide />
                      {/* Posts are written on the portal, where users write theirs. */}
                      <a href={`${await portalAddress(slug)}/feedback`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
                        <ExternalLinkIcon />
                        New post
                        <span className="sr-only"> (on your portal)</span>
                      </a>
                    </div>
                  }
                />
              ) : (
                <EmptyState
                  title={q ? "No posts match your search" : board || group ? "No posts match" : tab === "open" ? "Nothing to triage" : tab === "duplicates" ? "No possible duplicates" : "No posts here"}
                  description={
                    q || board || group
                      ? "Try other words, or another board or tab."
                      : tab === "duplicates"
                        ? "Posts that may repeat an older one show here."
                        : "Posts show here when they have this status."
                  }
                  // The search taken off, the rest of the view kept.
                  action={
                    q && (
                      <Link href={withoutSearch} className={buttonVariants({ variant: "outline" })}>
                        Clear search
                      </Link>
                    )
                  }
                />
              )
            ) : (
              // All, mixing statuses: grouped under each status (with its count), as the tabs order them; one status (a
              // tab, or All holding one): a single list.
              <Card className="gap-0 py-0">
                {groups.map((group) => (
                  <section key={group.status ?? "all"} aria-label={group.status ? STATUS_LABELS[group.status] : undefined} className="border-t first:border-t-0">
                    {group.status && (
                      <h2 className="flex items-center gap-2 bg-muted/50 px-4 py-2 text-sm font-semibold sm:px-5">
                        <StatusDot status={group.status} />
                        {STATUS_LABELS[group.status]}
                        <span className="font-normal text-muted-foreground tabular-nums">{group.posts.length}</span>
                      </h2>
                    )}
                    <ul aria-label="Posts" className={cn("flex flex-col divide-y [&>:has(+[data-selected])]:border-transparent", group.status && "border-t")}>
                      {group.posts.map((post) => (
                        <PickedRow
                          key={post.id}
                          postId={post.id}
                          selected={post.number === open}
                          select={<SelectPost post={{ id: post.id, number: post.number, title: post.title, voteCount: post.voteCount, emails: emailing(post), sample: post.sample, visibility: seenAs(post), authorId: post.authorId }} />}
                          votes={<VoteBox count={post.voteCount} />}
                          board={post.board.name}
                          title={
                            <Link href={withPost(post.number)} scroll={false} aria-current={post.number === open ? "true" : undefined} className="hover:underline">
                              {post.title}
                            </Link>
                          }
                          badges={
                            <>
                              {post.sample && <SampleBadge />}
                              <VisibilityBadge visibility={seenAs(post)} />
                              {post._count.duplicateSuggestions > 0 && <Badge variant="highlight">Possible duplicate</Badge>}
                            </>
                          }
                          // A line of it is shown: no more than that goes into the page.
                          excerpt={post.body.trim().slice(0, 200) || undefined}
                          meta={
                            <>
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                <Avatar aria-hidden className="size-5">
                                  {post.author.image && <AvatarImage src={post.author.image} alt="" />}
                                  <AvatarFallback className="text-[0.6875rem]">{initial(post.author.name)}</AvatarFallback>
                                </Avatar>
                                <span className="truncate text-foreground/80">{post.author.name}</span>
                              </span>
                              <span aria-hidden>·</span>
                              <time dateTime={post.createdAt.toISOString()} className="whitespace-nowrap">
                                {timeAgo(post.createdAt)}
                              </time>
                              {post.commentCount > 0 && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span className="inline-flex items-center gap-1 tabular-nums">
                                    <MessageSquareIcon aria-hidden className="size-3.5" />
                                    {post.commentCount}
                                    <span className="sr-only">{post.commentCount === 1 ? " comment" : " comments"}</span>
                                  </span>
                                </>
                              )}
                              {totals.has(post.id) && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span>{asking(totals.get(post.id)!, project.askingProperty!, formats)}</span>
                                </>
                              )}
                            </>
                          }
                          owner={
                            post.owner && (
                              <Avatar className="size-6" title={`Owner: ${post.owner.name}`}>
                                {post.owner.image && <AvatarImage src={post.owner.image} alt="" />}
                                <AvatarFallback className="text-xs">{initial(post.owner.name)}</AvatarFallback>
                                <span className="sr-only">Owner: {post.owner.name}</span>
                              </Avatar>
                            )
                          }
                          // The group or the tab says the status: its menu a quiet button (the pill where they're mixed
                          // and ungrouped: Possible duplicates, and All while more of it is to load).
                          status={
                            <PostStatusMenu
                              projectSlug={slug}
                              postId={post.id}
                              status={post.status}
                              completing={{ title: post.title, emails: emails.get(post.id) ?? 0 }}
                              badge={mixedUngrouped}
                            />
                          }
                        />
                      ))}
                    </ul>
                  </section>
                ))}
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
        {open !== null && (
          <aside key={open} aria-label="Post" className="lg:sticky lg:top-18 lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:border-l lg:pl-6">
            <FeedbackPane projectSlug={slug} projectId={project.id} askingProperty={project.askingProperty} formats={formats} number={open} close={withPost(null)} />
          </aside>
        )}
      </div>
    </div>
  );
}
