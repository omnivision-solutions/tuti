import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { BellIcon, CircleCheckIcon, Clock3Icon, FlameIcon, MessageSquareIcon, RssIcon, TrendingUpIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { BoardSearch } from "@/components/board-search";
import { changelogByEmail } from "@/components/changelog-pages";
import { EmptyState } from "@/components/empty-state";
import { NewIdea, NewIdeaButton, NewIdeaLink } from "@/components/new-idea";
import { ShareIdeaBox } from "@/components/new-post-form";
import { PortalAvatar } from "@/components/portal-avatar";
import { StatusLabel } from "@/components/post-status-badge";
import { SampleBadge } from "@/components/sample-badge";
import { SubNav } from "@/components/sub-nav";
import { buttonVariants } from "@/components/ui/button";
import { SignInLink } from "@/components/sign-in-link";
import { ResendVerificationButton } from "@/components/verify-email-banner";
import { VoteButton, VoteCount } from "@/components/vote-button";
import { boardTexts } from "@/lib/board-texts";
import { formatDay, timeAgo } from "@/lib/format";
import { boardStatuses, nextPageHref, parsePostFilters, TEAM_SORTS } from "@/lib/post-filters";
import { boardPath, postPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";
import { portalAddress } from "@/server/custom-domains";
import { canActIn } from "@/server/membership";
import { getSession } from "@/server/session";
import { currentPostViewer } from "@/server/portal-access";
import { seesBoard } from "@/server/post-visibility";
import { portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";
import { boardPosts, boardsWithCounts, emailReach, recentlyShipped } from "@/server/post-lists";
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
  const [{ posts, more }, shipped, boards, reach] = await Promise.all([
    boardPosts(board, filters, viewer, { statuses, q, mine }),
    // Beside the default list (however it's asked for), which leaves completed ideas out; not beside a search's results.
    !q && statuses && statuses.length > 1 ? recentlyShipped(board.id, viewer) : [],
    boardsWithCounts(board.projectId, viewer),
    // Whether the shipped email would reach them, by the rule that sends it.
    voter ? emailReach(board.projectId, voter) : undefined,
  ]);
  const texts = boardTexts(board);
  // A tab: the board in that order, with the search, status and idea's title it has (from the first page).
  const tabHref = (sort: string) => {
    const params = new URLSearchParams({
      ...(sort !== "trending" && { sort }),
      ...(q && { q }),
      ...(first(searchParams.status) && { status: first(searchParams.status)! }),
      ...(title && { title }),
    });
    return params.size > 0 ? `${at(boardPath(board))}?${params}` : at(boardPath(board));
  };
  const shippedCard = shipped.length > 0 && (
    // Named by a label, not its heading's id: it's on the page twice (under the list for phones, in the sidebar), and ids are once.
    <section role="region" aria-label="Recently shipped" className="flex flex-col gap-1">
      <h2 className="group-label px-2.5 pb-1">Recently shipped</h2>
      <ul className="flex flex-col">
        {shipped.map((post) => (
          // No status badge: the heading says they shipped, and the title gets the room.
          <li key={post.id} className="flex gap-2.5 px-2.5 py-2">
            <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-status-completed" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Link href={at(postPath({ ...post, board }))} className="text-[0.9375rem] leading-snug font-semibold break-words hover:underline">
                {post.title}
              </Link>
              <span className="text-[0.8125rem] text-muted-foreground tabular-nums">
                {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"} · shipped {formatDay(post.shippedAt)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
  // Get updates: in the sidebar on wide screens, under the list below them (named by its heading once, by a label there: ids are once).
  // The changelog by email, read once for both copies of Get updates.
  const byEmail = await changelogByEmail(board.project, session, true);
  const getUpdates = (inSidebar: boolean) => (
    <section
      role="region"
      {...(inSidebar ? { "aria-labelledby": "get-updates" } : { "aria-label": "Get updates" })}
      className={cn("flex flex-col gap-3 text-sm", inSidebar ? "border-t px-2.5 pt-6" : "rounded-xl bg-card p-5 shadow-card ring-1 ring-border")}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={inSidebar ? "get-updates" : undefined} className="flex items-center gap-2 font-sans text-[0.9375rem] font-semibold">
          <BellIcon aria-hidden className="size-4" />
          Get updates
        </h2>
        <a
          href={at("/changelog/rss.xml")}
          aria-label="RSS feed"
          title="RSS feed"
          className={buttonVariants({ variant: "outline", size: "icon-sm", className: "text-muted-foreground" })}
        >
          <RssIcon aria-hidden />
        </a>
      </div>
      {/* Only what holds for them: the team, someone the project's sign-on gave no address, or not a reader of a private portal hears nothing. */}
      {!session ? (
        <p className="text-muted-foreground">Vote for an idea to hear when it ships.</p>
      ) : !voter ? (
        // Signed in through another project's single sign-on: as the vote buttons say.
        <p className="text-muted-foreground">
          <SignInLink className="text-foreground underline underline-offset-4">Sign in</SignInLink> to vote
        </p>
      ) : reach?.status === "emailed" ? (
        <p className="text-muted-foreground">Vote for an idea to get an email when it ships.</p>
      ) : reach?.status === "unconfirmed" ? (
        <div className="flex flex-col items-start gap-1">
          <p className="text-muted-foreground">Confirm your email to hear when ideas you vote on ship.</p>
          <ResendVerificationButton email={session.user.email} callbackURL={at(boardPath(board))} />
        </div>
      ) : reach?.status === "optedOut" || reach?.status === "turnedOff" ? (
        // All of the project's emails, or those about ideas they vote on: either way, their Account turns them back on.
        <p className="text-muted-foreground">
          <Link href={at("/account")} className="text-foreground underline underline-offset-4">
            You&apos;ve unsubscribed from these emails.
          </Link>
        </p>
      ) : null}
      {byEmail}
      <Link href={at("/changelog")} className="self-start font-medium text-foreground underline decoration-primary/55 decoration-[1.5px] underline-offset-[3px]">
        Read the changelog
      </Link>
    </section>
  );
  const sortIcons = { trending: FlameIcon, top: TrendingUpIcon, new: Clock3Icon, mine: UserIcon } as const;
  return (
    // On wide screens a rail beside the list: New idea, the boards (when there are two or more, as the header's row), Recently
    // shipped and Get updates (the shipped emails, the changelog by email, its page and its feed).
    <NewIdea
      signedIn={!!session}
      opened={searchParams.new !== undefined}
      projectSlug={projectSlug}
      boardSlug={boardSlug}
      mediaUrls={await mediaUrls()}
      defaultTitle={title}
      {...texts}
    >
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_18.5rem] lg:items-start lg:gap-10">
        <div className="flex min-w-0 flex-col">
          {/* The list's card: what it's for (the team's words, Feedback → Boards, or a line that says how it works), then its
              sort tabs and search on one row. `?status=` (no control of its own any more), the search and `?title=` go with each
              tab; the sort, `?status=` and `?title=` with a search. Phones: no card, the title beside New idea. */}
          <section aria-label="Ideas" className="flex flex-col">
            <div className="flex flex-col sm:rounded-xl sm:bg-card sm:shadow-card sm:ring-1 sm:ring-border">
              <div className="flex items-start gap-3 sm:px-7 sm:pt-7">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <h1 className="font-heading text-[1.625rem] leading-tight font-[650] tracking-[-0.022em] break-words sm:text-[2.125rem]">{board.name}</h1>
                  <p className="text-[0.9375rem] text-muted-foreground sm:text-base">{board.description || "Vote for the ideas you want most, or share your own."}</p>
                </div>
                <NewIdeaButton className="mt-0.5 lg:hidden" />
              </div>
              <div className="mt-4 flex items-center gap-2 border-b sm:mt-6 sm:border-t sm:border-b-0 sm:px-5">
                <div className="min-w-0 flex-1">
                  <SubNav
                    label="Sort"
                    current={tabHref(tab)}
                    // A tab reorders the list under it: the page stays where it is.
                    scroll={false}
                    className="mt-0 shadow-none"
                    itemClassName="inline-flex items-center gap-1.5 px-2.5 py-0 h-12 sm:h-[3.375rem] text-[0.9375rem] font-medium data-[active]:[&>svg]:text-primary"
                    items={[...TABS, ...(voter ? [["mine", "Mine"] as const] : [])].map(([key, title]) => {
                      const Icon = sortIcons[key];
                      return {
                        href: tabHref(key),
                        title: (
                          <>
                            <Icon aria-hidden className="size-4" />
                            {title}
                          </>
                        ),
                      };
                    })}
                  />
                </div>
                <BoardSearch action={at(boardPath(board))} q={q ?? ""}>
                  {tab !== "trending" && <input type="hidden" name="sort" value={tab} />}
                  {first(searchParams.status) && <input type="hidden" name="status" value={first(searchParams.status)} />}
                  {title && <input type="hidden" name="title" value={title} />}
                </BoardSearch>
              </div>
            </div>
            {/* Without JavaScript New idea can't open its dialog: the board's box in the page instead (signed out, it goes to sign in
              and back with the title; ShareIdeaBox). */}
          <noscript>
            <div className="mt-4">
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
              <ul className="mt-2 flex flex-col divide-y">
                {posts.map((post) => (
                  <li key={post.id} className="flex items-start gap-4 py-5 sm:gap-5 sm:px-7 sm:py-[1.375rem]">
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
              className="mt-6"
              title={q ? "No ideas match" : mine ? "Nothing of yours yet" : statuses?.length === 1 ? "No posts with this status yet" : statuses ? "No ideas waiting" : "No feedback yet"}
              description={
                q
                  ? "Try other words, or share it as an idea."
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
              href={nextPageHref(searchParams, filters)}
              scroll={false}
              className={buttonVariants({ variant: "outline", className: "mt-4 self-center" })}
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
              <p className="mt-2 border-t pt-8 text-center text-sm text-muted-foreground">
                That&apos;s all {posts.length} ideas still to come in {board.name}. <NewIdeaLink>Share yours</NewIdeaLink>
              </p>
            )
          )}

          {/* On wide screens they're in the rail. */}
          {shippedCard && <div className="mt-10 lg:hidden">{shippedCard}</div>}
          <div className="mt-8 lg:hidden">{getUpdates(false)}</div>
        </div>

        <aside aria-label="About this board" className="hidden flex-col gap-6 lg:flex">
          <NewIdeaButton size="lg" className="h-12 w-full rounded-xl text-[0.9375rem]" />
          {boards.length > 1 && (
            <nav aria-label="Boards" className="flex flex-col gap-1 rounded-xl bg-card p-2.5 shadow-card ring-1 ring-border">
              <h2 className="group-label px-2.5 pt-2 pb-1.5">Boards</h2>
              <ul className="flex flex-col gap-0.5">
                {boards.map((other) => (
                  <li key={other.id}>
                    <Link
                      href={at(boardPath(other))}
                      aria-current={other.id === board.id ? "page" : undefined}
                      // Read out as "Bugs, 3 open ideas", not "Bugs3".
                      aria-label={`${other.name}, ${other._count.posts} ${other._count.posts === 1 ? "open idea" : "open ideas"}`}
                      className={cn(
                        "flex min-h-10 items-center gap-2 rounded-lg px-2.5 py-2 text-[0.9375rem] font-medium transition-colors",
                        other.id === board.id ? "bg-soft text-soft-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
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
          {shippedCard}
          {getUpdates(true)}
        </aside>
      </div>
    </NewIdea>
  );
}
