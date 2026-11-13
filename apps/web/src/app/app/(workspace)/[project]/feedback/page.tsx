import { prisma } from "@tuti/db";
import { seenAs } from "@tuti/jobs";
import { ExternalLinkIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { HidesTabBar } from "@/components/app-sidebar";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { FeedbackKeys, ListScrollReset } from "@/components/feedback-keys";
import { FeedbackPane } from "@/components/feedback-pane";
import { FeedbackSearch } from "@/components/feedback-search";
import { FeedbackBulk, FeedbackSelection, FiltersFold, PickedRow, SelectPost, VoteBox } from "@/components/feedback-selection";
import { ListFilters } from "@/components/list-filters";
import { feedbackMenu } from "@/components/feedback-menu";
import { FilterPills } from "@/components/filter-pills";
import { ItemGroup } from "@/components/item-list";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { PostStatusMenu } from "@/components/post-status-select";
import { STATUS_LABELS, StatusIcon } from "@/components/post-status-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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

  // A post open beside the list: the menu only where there's room for three panes.
  // Its counts the list's own when they're across every board.
  const [menu, portal] = await Promise.all([
    feedbackMenu({
      project: membership.project,
      role: membership.role,
      view: tab,
      board,
      counts: !board && !q && !group ? counts : undefined,
      className: cn(open !== null && "@max-[80rem]/app:hidden!"),
    }),
    portalAddress(slug),
  ]);
  // The view's name: the board's, filtered to one, else the tab's.
  const title = (board && project.boards.find((b) => b.slug === board)?.name) ?? (tab === "all" ? "All posts" : tabs.find((t) => t.key === tab)!.title);

  return (
    <PaneLayout>
      {menu}
      <FeedbackKeys order={listed.map((post) => post.number)} open={open} base={withPost(null)} />
      {/* A post open beside the list has the phone's screen to itself: no tab bar. */}
      {open !== null && <HidesTabBar />}
      {/* Rows picked for Set status, Move to board and Merge, the bar over the header's row once some are. */}
      <FeedbackSelection listKey={listKey.toString()} listed={listed.map((post) => ({ id: post.id, number: post.number, title: post.title, voteCount: post.voteCount, emails: emailing(post), sample: post.sample, visibility: seenAs(post), authorId: post.authorId }))}>
        {/* The list and, beside it, the post a row opened. Under the shell's 48rem (where the window scrolls, not the
            panes: FeedbackKeys keeps the list's place) one or the other; from there up both, so the list's pane is never
            hidden while it holds its own scroll. */}
        <Pane aria-label="Feedback" className={cn(open !== null && "@max-[48rem]/app:hidden")}>
          <FeedbackBulk projectSlug={slug} boards={project.boards}>
            <PaneHeader
              // On phones; beside the menu, which marks it, the pills have the room.
              title={<span className="@min-[48rem]/app:sr-only">{title}</span>}
              // The statuses as pills, keeping the board, the search and the sort; scrolling sideways when short of room.
              filters={<FilterPills label="Statuses" current={href(tab)} items={tabs.map((t) => ({ href: href(t.key), title: t.title, count: t.count }))} />}
              actions={
                <>
                  <FeedbackSearch action={`/app/${slug}/feedback`} q={q}>
                    {board && <input type="hidden" name="board" value={board} />}
                    {group && <input type="hidden" name="group" value={group.key} />}
                    {filters.sort !== "top" && <input type="hidden" name="sort" value={filters.sort} />}
                    {duplicatesOnly ? <input type="hidden" name="show" value="duplicates" /> : tab !== "open" && <input type="hidden" name="status" value={tab} />}
                  </FeedbackSearch>
                  {/* Searching doesn't load a new page, so a screen reader hears what it found here (polite, there from the start). */}
                  <p role="status" className="sr-only">
                    {q ? `Search for “${q}” found ${listed.length === 0 ? "no posts" : listed.length === 1 && !more ? "1 post" : `${listed.length}${more ? " posts, and more to load" : " posts"}`}` : ""}
                  </p>
                  <FiltersFold set={[board, group, filters.sort !== "top" && filters.sort].filter(Boolean).length}>
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
                  {/* Posts are written on the portal, where users write theirs (as ⌘K's New post); a + on phones. Not
                      primary beside an open post's own. */}
                  <a
                    href={`${portal}/feedback`}
                    target="_blank"
                    rel="noreferrer"
                    title="New post"
                    className={buttonVariants({ variant: open === null ? "default" : "outline", size: "sm", className: "@max-[48rem]/app:size-8 @max-[48rem]/app:px-0" })}
                  >
                    <PlusIcon />
                    <span className="@max-[48rem]/app:sr-only">New post</span>
                    <span className="sr-only"> (on your portal)</span>
                  </a>
                </>
              }
            />
          </FeedbackBulk>
          <PaneBody className="flex flex-col gap-4 p-2 @min-[48rem]/app:p-3">
            {/* Another view of the list starts at its top; a post opened or closed beside it keeps its place. */}
            <ListScrollReset list={listKey.toString()} />
            {posts.length === 0 ? (
              counts.all === 0 && !q && !board && !group ? (
                <EmptyState
                  title="No feedback yet"
                  description="Share your portal with users, or connect your app with single sign-on in Settings."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <CopyButton value={portal} label="portal link" wide />
                      {/* Posts are written on the portal, where users write theirs. */}
                      <a href={`${portal}/feedback`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
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
              <div className="flex flex-col gap-1">
                {groups.map((group) => {
                  const rows = (
                    <ul aria-label="Posts" className="flex flex-col divide-y [&>:has(+[data-selected])]:border-transparent">
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
                  );
                  // Each status a group that folds, its count beside it.
                  return group.status ? (
                    <section key={group.status} aria-label={STATUS_LABELS[group.status]}>
                      <ItemGroup icon={<StatusIcon status={group.status} />} title={STATUS_LABELS[group.status]} count={group.posts.length}>
                        {rows}
                      </ItemGroup>
                    </section>
                  ) : (
                    <div key="all">{rows}</div>
                  );
                })}
              </div>
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
          </PaneBody>
        </Pane>
      </FeedbackSelection>
      {/* Keyed by the post: each one starts at the top of the pane (scrolling on its own), wherever the last was. */}
      {open !== null && (
        <Pane className="@min-[48rem]/app:w-[22rem] @min-[48rem]/app:flex-none @min-[60rem]/app:w-[26rem] @min-[76rem]/app:w-[30rem]">
          <PaneBody key={open} className="p-4 @min-[48rem]/app:p-5">
            <FeedbackPane projectSlug={slug} projectId={project.id} askingProperty={project.askingProperty} formats={formats} number={open} close={withPost(null)} />
          </PaneBody>
        </Pane>
      )}
    </PaneLayout>
  );
}
