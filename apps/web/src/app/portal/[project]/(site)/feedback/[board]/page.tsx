import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { CircleCheckIcon, Clock3Icon, FlameIcon, MessageSquareIcon, SearchIcon, TrendingUpIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { BoardSearch } from "@/components/board-search";
import { BoardStatusMenu, type StatusChoice } from "@/components/board-status-menu";
import { boardGetUpdates } from "@/components/board-get-updates";
import { EmptyState } from "@/components/empty-state";
import { NewIdea, NewIdeaButton, NewIdeaLink } from "@/components/new-idea";
import { postButtonText } from "@/components/new-post-menu";
import { ShareIdeaBox } from "@/components/new-post-form";
import { PortalAvatar } from "@/components/portal-avatar";
import { STATUS_LABELS, StatusLabel } from "@/components/post-status-badge";
import { SampleBadge } from "@/components/sample-badge";
import { BoardPillRow, BoardSwitcher } from "@/components/board-switcher";
import { FilterPills } from "@/components/filter-pills";
import { PortalPageHeader } from "@/components/portal-page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VoteButton, VoteCount } from "@/components/vote-button";
import { boardTexts } from "@/lib/board-texts";
import { formatDay, timeAgo } from "@/lib/format";
import { ACTIVE_STATUSES, boardStatuses, nextPageHref, parsePostFilters, STATUS_PARAMS, TEAM_SORTS } from "@/lib/post-filters";
import { boardPath, postPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";
import { portalAddress } from "@/server/custom-domains";
import { canActIn } from "@/server/membership";
import { getSession } from "@/server/session";
import { currentPostViewer } from "@/server/portal-access";
import { seesBoard } from "@/server/post-visibility";
import { portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";
import { boardPosts, boardStatusCounts, boardsWithCounts, recentlyShipped } from "@/server/post-lists";
import { VisibilityBadge } from "@/components/visibility-badge";

/** A board's tabs, its orders: Trending (the most votes in the last 7 days, then the most votes) first. */
const TABS = [
  ["trending", "Trending"],
  ["top", "Top"],
  ["new", "New"],
] as const;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Sorted, searched or filtered (`?sort=`, `?q=`, `?status=`), it's still the board: one address for search engines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/feedback/[board]">): Promise<Metadata> {
  const { project, board } = await props.params;
  return { alternates: { canonical: `${await portalAddress(project)}${boardPath({ slug: board })}` } };
}

export default async function BoardPage(props: PageProps<"/portal/[project]/feedback/[board]">) {
  const at = await portalLinks();
  const { project: projectSlug, board: boardSlug } = await props.params;
  const searchParams = await props.searchParams;
  const q = first(searchParams.q)?.trim().slice(0, 255) || undefined;
  // "Post this as feedback" from the docs starts the post with the question.
  const title = typeof searchParams.title === "string" ? searchParams.title : undefined;
  const session = await getSession();

  const found = await prisma.board.findFirst({
    where: { slug: boardSlug, project: { slug: projectSlug } },
    include: { project: { select: { id: true, name: true, slug: true, portalAccess: true } } },
  });
  // A Team only board, or one turned off, is the team's: not on the portal for anyone else (post-visibility.ts).
  const viewer = found && (await currentPostViewer(found.projectId));
  const board = found && viewer && seesBoard(viewer, found) ? found : null;
  if (!board || !viewer) {
    // An old URL of a board that has since moved?
    const moved =
      !found &&
      (await prisma.boardRedirect.findFirst({
        where: { slug: boardSlug, project: { slug: projectSlug } },
        select: { board: { select: { slug: true, postVisibility: true, off: true, projectId: true } } },
      }));
    // Not to the team's own board, but for the team: its new address is the team's too.
    if (moved && seesBoard(await currentPostViewer(moved.board.projectId), moved.board)) {
      permanentRedirect(at(boardPath(moved.board)));
    }
    notFound();
  }

  // As voting checks it: someone signed in through another project's single sign-on can't vote here.
  const voter = session && (await canActIn(session.user.id, board.projectId)) ? session.user.id : null;
  // Mine (`?sort=mine`): what they posted or voted for, newest first; only for someone who may vote here.
  const mine = !!voter && first(searchParams.sort) === "mine";
  const filters = parsePostFilters(searchParams, TEAM_SORTS, mine ? "new" : "trending");
  const tab = mine ? "mine" : filters.sort;
  // A search looks through every status (it's for one idea, shipped or not), unless the address asks for one; so does Mine.
  const statuses = (q || mine) && !first(searchParams.status) ? undefined : boardStatuses(searchParams);
  const [{ posts, more }, shipped, boards, counts] = await Promise.all([
    boardPosts(board, filters, viewer, { statuses, q, mine }),
    // Beside the default list (however it's asked for), which leaves completed ideas out; not beside a search's results.
    !q && statuses && statuses.length > 1 ? recentlyShipped(board.id, viewer) : [],
    boardsWithCounts(board.projectId, viewer),
    boardStatusCounts(board.id, viewer),
  ]);
  const texts = boardTexts(board);
  // The board's own links built from its address (Load more) leave out `new` and `title`: New idea's, taken out of the
  // address as it opens (NewIdea), never to open it again.
  const ownParams = Object.fromEntries(Object.entries(searchParams).filter(([name]) => name !== "new" && name !== "title"));
  // A tab: the board in that order, with the search and status it has (from the first page); not `?title=`, which New idea
  // took from the address as it opened.
  // `status`: the address's unless given; `null` for none.
  const listHref = (sort: string, given?: string | null) => {
    const status = given === undefined ? first(searchParams.status) : given;
    const params = new URLSearchParams({
      ...(sort !== "trending" && { sort }),
      ...(q && { q }),
      ...(status && { status }),
    });
    return params.size > 0 ? `${at(boardPath(board))}?${params}` : at(boardPath(board));
  };
  const tabHref = (sort: string) => listHref(sort);
  // The status menu (the sort and search kept): the ideas not done yet (the default list; under a search or Mine, which
  // look through every status, asked for by name), each status with ideas on the board, then every idea.
  const count = (list: readonly string[]) => list.reduce((total, status) => total + (counts[status as keyof typeof counts] ?? 0), 0);
  const paramOf = (status: string) => Object.keys(STATUS_PARAMS).find((key) => STATUS_PARAMS[key] === status)!;
  const searching = !!q || mine;
  const statusChoices: StatusChoice[] = [
    { label: "Not done yet", count: count(ACTIVE_STATUSES), href: listHref(tab, searching ? "active" : null), current: !!statuses && statuses.length > 1, group: 0 },
    ...(["IN_PROGRESS", "PLANNED", "UNDER_REVIEW", "OPEN", "COMPLETED", "CLOSED"] as const)
      .filter((status) => counts[status] || (statuses?.length === 1 && statuses[0] === status))
      .map((status) => ({
        label: STATUS_LABELS[status],
        count: counts[status] ?? 0,
        href: listHref(tab, paramOf(status)),
        status,
        current: statuses?.length === 1 && statuses[0] === status,
        group: ACTIVE_STATUSES.includes(status) ? 1 : 2,
      })),
    { label: "Every idea", count: count(Object.values(STATUS_PARAMS)), href: listHref(tab, searching ? null : "all"), current: !statuses, group: 3 },
  ];
  const latest = shipped[0];
  const shippedLine = latest && (
    // One line: the latest shipped idea and when; the rest under Completed in the status menu.
    <section role="region" aria-label="Recently shipped" className="flex gap-2 text-sm leading-snug text-muted-foreground">
      <CircleCheckIcon aria-hidden className="mt-px size-4 shrink-0 text-status-completed" />
      <p className="min-w-0 break-words">
        Shipped {formatDay(latest.shippedAt)}:{" "}
        <Link href={at(postPath({ ...latest, board }))} className="font-medium text-foreground hover:underline">
          {latest.title}
        </Link>
      </p>
    </section>
  );
  const getUpdates = await boardGetUpdates({ project: board.project, session, voter, back: boardPath(board) });
  // The header's primary: the board's own button text (Boards → Button), else "New post".
  const postLabel = postButtonText(board);
  // A search that found nothing: it's the next step, and says so.
  const newIdeaLabel = q && posts.length === 0 ? "Not here? Post it" : postLabel;
  const sortIcons = { trending: FlameIcon, top: TrendingUpIcon, new: Clock3Icon, mine: UserIcon } as const;
  const search = (className?: string) => (
    <BoardSearch action={at(boardPath(board))} q={q ?? ""} className={className}>
      {tab !== "trending" && <input type="hidden" name="sort" value={tab} />}
      {first(searchParams.status) && <input type="hidden" name="status" value={first(searchParams.status)} />}
    </BoardSearch>
  );
  return (
    // The visitor's job: is my idea here? then vote or post it. So the list leads: the header's one row has the sort and
    // status pills, the search, Get updates and the board's button; on wide screens a rail beside the list with the boards
    // (two or more) and the latest shipped idea.
    <NewIdea
      signedIn={!!session}
      opened={searchParams.new !== undefined}
      projectSlug={projectSlug}
      boardSlug={boardSlug}
      mediaUrls={await mediaUrls()}
      defaultTitle={title}
      {...texts}
    >
      <PortalPageHeader
        title={board.name}
        description={board.description || "Vote for the ideas you want most, or share your own."}
        // The search and `?status=` go with each sort; the sort and `?status=` with a search; the sort and search with a status.
        // Phones: one row that scrolls sideways, the board switcher first (the rail's boards are on wide screens only).
        pills={
          <BoardPillRow>
            {boards.length > 1 && (
              <>
                <BoardSwitcher
                  name={board.name}
                  allHref={at("/feedback")}
                  boards={boards.map((other) => ({ name: other.name, href: at(boardPath(other)), count: other._count.posts, current: other.id === board.id }))}
                  className="lg:hidden"
                />
                <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border lg:hidden" />
              </>
            )}
            <div className="shrink-0">
              <FilterPills
                label="Sort"
                current={tabHref(tab)}
                items={[...TABS, ...(voter ? [["mine", "Mine"] as const] : [])].map(([key, name]) => {
                  const Icon = sortIcons[key];
                  return {
                    href: tabHref(key),
                    title: (
                      <>
                        <Icon aria-hidden />
                        {name}
                      </>
                    ),
                  };
                })}
              />
            </div>
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
            <BoardStatusMenu choices={statusChoices} counted={!searching} />
          </BoardPillRow>
        }
        actions={
          <>
            <div className="w-60">{search("h-9 sm:h-9 rounded-[0.625rem]")}</div>
            {getUpdates(true)}
            <NewIdeaButton label={newIdeaLabel} />
          </>
        }
        phoneActions={
          <>
            <Popover>
              <PopoverTrigger aria-label="Search" render={<Button variant="outline" size="icon-lg" className="rounded-full" />}>
                <SearchIcon aria-hidden />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[calc(100vw-2rem)] p-2">
                {search()}
              </PopoverContent>
            </Popover>
            <NewIdeaButton label={postLabel} round />
          </>
        }
      />
      <div className={cn("flex flex-col gap-6", (boards.length > 1 || shippedLine) && "lg:grid lg:grid-cols-[minmax(0,1fr)_15.5rem] lg:items-start lg:gap-14")}>
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label="Ideas" className="flex flex-col gap-2">
            {/* Without JavaScript New idea can't open its dialog: the board's box in the page instead (signed out, it goes to sign in
              and back with the title; ShareIdeaBox). */}
            <noscript>
              <div>
                <ShareIdeaBox signedIn={!!session} projectSlug={projectSlug} boardSlug={boardSlug} mediaUrls={null} defaultTitle={title} {...texts} />
              </div>
            </noscript>
            {/* What a search found, read out (the page doesn't reload, so nothing else is). */}
            <p role="status" className="sr-only">
              {q &&
                (posts.length === 0
                  ? `No ideas match "${q}"`
                  : `${posts.length}${more ? "+" : ""} ${posts.length === 1 && !more ? "idea matches" : "ideas match"} "${q}"`)}
            </p>
            {posts.length > 0 && (
              <ul className="flex flex-col divide-y border-b">
                {posts.map((post) => (
                  <li key={post.id} className="flex items-start gap-4 py-5 sm:gap-5 sm:py-[1.375rem]">
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      {/* Its status above the title (not Open, every new idea's), in its colour. */}
                      {post.status !== "OPEN" && <StatusLabel status={post.status} className="mb-1.5" />}
                      <h2 className="font-sans text-base leading-snug font-[650] tracking-[-0.01em] break-words sm:text-[1.0625rem]">
                        <Link href={at(postPath({ ...post, board }))} className="hover:underline">
                          {post.title}
                        </Link>
                      </h2>
                      {post.body && <p className="mt-1 line-clamp-2 text-[0.9375rem] leading-relaxed text-muted-foreground">{post.body}</p>}
                      {/* Who posted it and when, then how many comments. */}
                      <div className="mt-2.5 flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[0.84375rem] text-muted-foreground">
                        <span className="flex max-w-full min-w-0 items-center gap-2 whitespace-nowrap">
                          <PortalAvatar person={post.author} className="size-6 text-xs" />
                          <span className="min-w-0 truncate font-semibold text-foreground/80">{post.author.name}</span>
                          <time dateTime={post.createdAt.toISOString()}>{timeAgo(post.createdAt)}</time>
                          {post.commentCount > 0 && (
                            // The icon and the number for the eye, "3 comments" for screen readers (a label on a plain span isn't read).
                            <span className="ml-1 inline-flex items-center gap-1">
                              <MessageSquareIcon aria-hidden className="size-3.5" />
                              <span aria-hidden>{post.commentCount}</span>
                              <span className="sr-only">
                                {post.commentCount} {post.commentCount === 1 ? "comment" : "comments"}
                              </span>
                            </span>
                          )}
                        </span>
                        {post.sample && <SampleBadge />}
                        <VisibilityBadge visibility={post.visibility} />
                      </div>
                    </div>
                    {post.status === "COMPLETED" ? (
                      <VoteCount count={post.voteCount} shape="box" />
                    ) : (
                      <VoteButton shape="box" postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!voter} signedOut={!session} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {posts.length === 0 && (
            <EmptyState
              action={q ? <NewIdeaLink>Post it as a new idea</NewIdeaLink> : undefined}
              title={q ? "No ideas match" : mine ? "Nothing of yours yet" : statuses?.length === 1 ? "No posts with this status yet" : statuses ? "No ideas waiting" : "No feedback yet"}
              description={
                q
                  ? "Try other words. Not here yet?"
                  : mine
                    ? "Ideas you share or vote for on this board show up here."
                    : statuses?.length === 1
                      ? "Try another status."
                      : "Be the first to share an idea."
              }
            />
          )}
          {more ? (
            <Link
              href={nextPageHref(ownParams, filters)}
              scroll={false}
              className={buttonVariants({ variant: "outline", className: "self-center" })}
            >
              Load more
            </Link>
          ) : (
            // The end of the default list (what's still to come; shipped ones are in Recently shipped): how many, and the way
            // to add one. Not under a search, Mine or a status asked for by address.
            posts.length > 1 &&
            !q &&
            !mine &&
            !first(searchParams.status) && (
              <p className="pt-2 text-center text-sm text-muted-foreground">
                That&apos;s all {posts.length} ideas still to come in {board.name}. <NewIdeaLink>Share yours</NewIdeaLink>
              </p>
            )
          )}

          {/* A search that found some: the way to post it if it isn't among them. */}
          {q && posts.length > 0 && !more && (
            <p className="pt-2 text-center text-sm text-muted-foreground">
              Not here? <NewIdeaLink>Post it</NewIdeaLink>
            </p>
          )}

          {/* On wide screens it's in the rail. */}
          {shippedLine && <div className="lg:hidden">{shippedLine}</div>}
          <div className="sm:hidden">{getUpdates(false)}</div>
        </div>

        {/* A plain column (no card): the boards, the open one a neutral fill, and the latest shipped idea. */}
        {(boards.length > 1 || shippedLine) && (
          <aside aria-label="About this board" className="hidden flex-col gap-7 lg:flex">
            {boards.length > 1 && (
              <nav aria-label="Boards" className="flex flex-col gap-1.5">
                <h2 className="text-[0.8125rem] font-medium text-muted-foreground">Boards</h2>
                <ul className="flex flex-col gap-0.5">
                  {boards.map((other) => (
                    <li key={other.id}>
                      <Link
                        href={at(boardPath(other))}
                        aria-current={other.id === board.id ? "page" : undefined}
                        // Read out as "Bugs, 3 open ideas", not "Bugs3".
                        aria-label={`${other.name}, ${other._count.posts} ${other._count.posts === 1 ? "open idea" : "open ideas"}`}
                        className={cn(
                          "-mx-2.5 flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[0.9375rem] font-medium transition-colors",
                          other.id === board.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <span className="min-w-0 flex-1 break-words">{other.name}</span>
                        <span className="text-[0.8125rem] tabular-nums">{other._count.posts}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            {shippedLine && (
              <div className="flex flex-col gap-2">
                <h2 className="text-[0.8125rem] font-medium text-muted-foreground">Recently shipped</h2>
                {shippedLine}
              </div>
            )}
          </aside>
        )}
      </div>
    </NewIdea>
  );
}
