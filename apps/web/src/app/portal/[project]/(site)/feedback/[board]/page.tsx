import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { CheckIcon, MessageSquareIcon, RssIcon } from "lucide-react";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { BoardSearch } from "@/components/board-search";
import { changelogByEmail } from "@/components/changelog-pages";
import { EmptyState } from "@/components/empty-state";
import { ShareIdeaBox } from "@/components/new-post-form";
import { PageHeader } from "@/components/page-header";
import { PostStatusBadge } from "@/components/post-status-badge";
import { SampleBadge } from "@/components/sample-badge";
import { SubNav } from "@/components/sub-nav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { buttonVariants } from "@/components/ui/button";
import { SignInLink } from "@/components/sign-in-link";
import { ResendVerificationButton } from "@/components/verify-email-banner";
import { VoteButton, VoteCount } from "@/components/vote-button";
import { boardTexts } from "@/lib/board-texts";
import { timeAgo } from "@/lib/format";
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
    <section role="region" aria-label="Recently shipped" className="flex flex-col gap-2">
      <h2 className="group-label">Recently shipped</h2>
      <ul className="flex flex-col gap-2.5">
        {shipped.map((post) => (
          // No status badge: the heading says they shipped, and the title gets the room.
          <li key={post.id} className="flex items-baseline gap-2 text-sm">
            <CheckIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-status-completed" />
            <Link href={at(postPath({ ...post, board }))} className="min-w-0 flex-1 break-words hover:underline">
              {post.title}
            </Link>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
  // Get updates: in the sidebar on wide screens, under the list below them (named by its heading once, by a label there: ids are once).
  const getUpdates = async (inSidebar: boolean) => (
    <section
      {...(inSidebar ? { "aria-labelledby": "get-updates" } : { "aria-label": "Get updates" })}
      className="flex flex-col gap-3 rounded-xl bg-card p-4 text-sm shadow-xs ring-1 ring-border"
    >
      <h2 id={inSidebar ? "get-updates" : undefined} className="font-semibold">
        Get updates
      </h2>
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
      {await changelogByEmail(board.project, session, true)}
      <p className="flex items-center gap-3 text-muted-foreground">
        <Link href={at("/changelog")} className="hover:text-foreground hover:underline">
          Changelog
        </Link>
        <span aria-hidden>·</span>
        <a href={at("/changelog/rss.xml")} className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
          <RssIcon aria-hidden className="size-3.5" /> RSS
        </a>
      </p>
    </section>
  );
  return (
    // On wide screens a sidebar beside the list: the boards (when there are two or more, as the header's row), Recently shipped and
    // Get updates (the shipped emails, the changelog by email, its page and its feed).
    <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        {/* What it's for, in the team's words (Feedback → Boards), or a line that says how it works. */}
        <PageHeader title={board.name} description={board.description || "Vote for the ideas you want most, or share your own."} />

        <ShareIdeaBox
          signedIn={!!session}
          projectSlug={projectSlug}
          boardSlug={boardSlug}
          mediaUrls={await mediaUrls()}
          defaultTitle={title}
          {...texts}
        />

        {/* The list's card: its sort tabs and search on one bar, the ideas under it. `?status=` (no control of its own any more),
            the search and `?title=` go with each tab; the sort, `?status=` and `?title=` with a search. */}
        <div className="flex flex-col gap-3">
          <section aria-label="Ideas">
            {/* One line under the tabs and the search together (the tabs' own line off). */}
            <div className="flex flex-col gap-2 border-b max-sm:pb-3 sm:flex-row sm:items-end sm:[&_form]:mb-1.5">
              <div className="min-w-0 flex-1 [&>nav]:mt-0 [&>nav]:shadow-none">
                <SubNav
                  label="Sort"
                  current={tabHref(tab)}
                  // A tab reorders the list under it: the page stays where it is.
                  scroll={false}
                  items={[...TABS, ...(voter ? [["mine", "Mine"] as const] : [])].map(([key, title]) => ({ href: tabHref(key), title }))}
                />
              </div>
              <BoardSearch action={at(boardPath(board))} q={q ?? ""}>
                {tab !== "trending" && <input type="hidden" name="sort" value={tab} />}
                {first(searchParams.status) && <input type="hidden" name="status" value={first(searchParams.status)} />}
                {title && <input type="hidden" name="title" value={title} />}
              </BoardSearch>
              {/* What a search found, read out (the page doesn't reload, so nothing else is). */}
              <p role="status" className="sr-only">
                {q &&
                  (posts.length === 0
                    ? `No ideas match "${q}"`
                    : `${posts.length}${more ? "+" : ""} ${posts.length === 1 && !more ? "idea matches" : "ideas match"} "${q}"`)}
              </p>
            </div>
            {posts.length > 0 && (
              <ul className="flex flex-col divide-y">
                {posts.map((post) => (
                  <li key={post.id} className="flex items-start gap-4 py-5">
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                      <h2 className="text-lg leading-snug font-semibold tracking-tight break-words">
                        <Link href={at(postPath({ ...post, board }))} className="hover:underline">
                          {post.title}
                        </Link>
                      </h2>
                      {post.body && <p className="line-clamp-2 text-[0.9375rem] leading-relaxed text-foreground/75">{post.body}</p>}
                      {/* Under the title (every title at the same height): who posted it and when, then its status. */}
                      <div className="mt-1 flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted-foreground">
                        {/* Who and when first, on one line (the name cut short first): every byline starts at the same edge. */}
                        <span className="flex max-w-full min-w-0 items-center gap-2 whitespace-nowrap">
                          <Avatar size="sm" aria-hidden className="size-5">
                            {post.author.image && <AvatarImage src={post.author.image} alt="" />}
                            <AvatarFallback className="text-xs">{post.author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <span className="min-w-0 truncate text-foreground/80">{post.author.name}</span>
                          <span aria-hidden>·</span>
                          <time dateTime={post.createdAt.toISOString()}>{timeAgo(post.createdAt)}</time>
                          {post.commentCount > 0 && (
                            <span className="ml-1 inline-flex items-center gap-1" aria-label={`${post.commentCount} ${post.commentCount === 1 ? "comment" : "comments"}`}>
                              <MessageSquareIcon aria-hidden className="size-3.5" />
                              {post.commentCount}
                            </span>
                          )}
                        </span>
                        {/* Then its status (not Open, every new idea's). */}
                        {post.status !== "OPEN" && <PostStatusBadge status={post.status} />}
                        {post.sample && <SampleBadge />}
                        <VisibilityBadge visibility={post.visibility} />
                      </div>
                    </div>
                    {post.status === "COMPLETED" ? (
                      <VoteCount count={post.voteCount} pill />
                    ) : (
                      <VoteButton pill postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!voter} signedOut={!session} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {posts.length === 0 && (
            <EmptyState
              title={q ? "No ideas match" : mine ? "Nothing of yours yet" : statuses?.length === 1 ? "No posts with this status yet" : statuses ? "No ideas waiting" : "No feedback yet"}
              description={
                q
                  ? "Try other words, or share it as an idea."
                  : mine
                    ? "Ideas you share or vote for on this board show up here."
                    : statuses?.length === 1
                    ? "Try another status."
                    : statuses
                      ? "Share one in the box above."
                      : "Be the first to share an idea."
              }
            />
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

        {/* On wide screens they're in the sidebar. */}
        {shippedCard && <div className="lg:hidden">{shippedCard}</div>}
        <div className="lg:hidden">{await getUpdates(false)}</div>
      </div>

      <aside aria-label="About this board" className="hidden flex-col gap-8 lg:flex">
        {boards.length > 1 && (
          <nav aria-label="Boards" className="flex flex-col gap-2">
            <h2 className="group-label">Boards</h2>
            <ul className="flex flex-col">
              {boards.map((other) => (
                <li key={other.id}>
                  <Link
                    href={at(boardPath(other))}
                    aria-current={other.id === board.id ? "page" : undefined}
                    // Read out as "Bugs, 3 open ideas", not "Bugs3".
                    aria-label={`${other.name}, ${other._count.posts} ${other._count.posts === 1 ? "open idea" : "open ideas"}`}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-2.5 py-2 text-[0.9375rem] transition-colors hover:bg-accent",
                      other.id === board.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 break-words">{other.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{other._count.posts}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {shippedCard}
        {await getUpdates(true)}
      </aside>
    </div>
  );
}
