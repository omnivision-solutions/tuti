import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { RssIcon } from "lucide-react";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { BoardSearch } from "@/components/board-search";
import { EmptyState } from "@/components/empty-state";
import { ShareIdeaBox } from "@/components/new-post-form";
import { PageHeader } from "@/components/page-header";
import { PostStatusBadge } from "@/components/post-status-badge";
import { SubNav } from "@/components/sub-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { SignInLink } from "@/components/sign-in-link";
import { ResendVerificationButton } from "@/components/verify-email-banner";
import { VoteButton } from "@/components/vote-button";
import { boardTexts } from "@/lib/board-texts";
import { boardStatuses, nextPageHref, parsePostFilters, TEAM_SORTS } from "@/lib/post-filters";
import { boardPath, postPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";
import { portalAddress } from "@/server/custom-domains";
import { canActIn } from "@/server/membership";
import { getSession } from "@/server/session";
import { portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";
import { boardPosts, boardsWithCounts, emailReach, recentlyShipped } from "@/server/post-lists";

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
  const userId = session?.user.id;

  const board = await prisma.board.findFirst({
    where: { slug: boardSlug, project: { slug: projectSlug } },
  });
  if (!board) {
    // An old URL of a board that has since moved?
    const moved = await prisma.boardRedirect.findFirst({
      where: { slug: boardSlug, project: { slug: projectSlug } },
      select: { board: { select: { slug: true } } },
    });
    if (moved) {
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
    boardPosts(board, filters, userId, { statuses, q, mine }),
    // Beside the default list (however it's asked for), which leaves completed ideas out; not beside a search's results.
    !q && statuses && statuses.length > 1 ? recentlyShipped(board.id) : [],
    boardsWithCounts(board.projectId),
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
    <Card role="region" aria-label="Recently shipped" size="sm">
      <CardHeader>
        <CardTitle>
          <h2>Recently shipped</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {shipped.map((post) => (
            <li key={post.id} className="flex items-center gap-3 text-sm">
              <PostStatusBadge status="COMPLETED" />
              <Link href={at(postPath({ ...post, board }))} className="min-w-0 flex-1 break-words hover:underline">
                {post.title}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
  return (
    // On wide screens a sidebar beside the list: the boards (when there are two or more, as the header's row), Recently shipped and Get updates.
    <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader title={board.name} description={board.description} />

        <ShareIdeaBox
          signedIn={!!session}
          projectSlug={projectSlug}
          boardSlug={boardSlug}
          mediaUrls={await mediaUrls()}
          defaultTitle={title}
          {...texts}
        />

        {/* `?status=` (no control of its own any more), the search and `?title=` go with each tab; the sort, `?status=` and `?title=` with a search. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 [&>nav]:mt-0">
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

        <div className="flex flex-col gap-3">
          {posts.length > 0 && (
            <Card size="sm">
              <CardContent>
                <ul className="flex flex-col divide-y">
                  {posts.map((post) => (
                    <li key={post.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                        <PostStatusBadge status={post.status} />
                        <h2 className="font-medium break-words">
                          <Link href={at(postPath({ ...post, board }))} className="hover:underline">
                            {post.title}
                          </Link>
                        </h2>
                        {post.body && <p className="line-clamp-1 text-sm text-muted-foreground">{post.body}</p>}
                        <p className="text-xs text-muted-foreground">
                          {post.author.name}
                          {post.commentCount > 0 && ` · ${post.commentCount} ${post.commentCount === 1 ? "comment" : "comments"}`}
                        </p>
                      </div>
                      <VoteButton postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!voter} />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
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

        {/* On wide screens it's in the sidebar. */}
        {shippedCard && <div className="lg:hidden">{shippedCard}</div>}
      </div>

      <aside aria-label="About this board" className="hidden flex-col gap-4 lg:flex">
        {boards.length > 1 && (
          <Card size="sm">
            <CardContent>
              <nav aria-label="Boards">
                <h2 className="mb-2 text-sm font-medium">Boards</h2>
                <ul className="-mx-2 flex flex-col">
                  {boards.map((other) => (
                    <li key={other.id}>
                      <Link
                        href={at(boardPath(other))}
                        aria-current={other.id === board.id ? "page" : undefined}
                        // Read out as "Bugs, 3 open ideas", not "Bugs3".
                        aria-label={`${other.name}, ${other._count.posts} ${other._count.posts === 1 ? "open idea" : "open ideas"}`}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                          other.id === board.id ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <span className="min-w-0 flex-1 break-words">{other.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{other._count.posts}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </CardContent>
          </Card>
        )}
        {shippedCard}
        <Card role="region" aria-labelledby="get-updates" size="sm">
          <CardHeader>
            <CardTitle>
              <h2 id="get-updates">Get updates</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
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
          <div className="flex flex-wrap gap-2">
              <Link href={at("/changelog")} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Changelog
              </Link>
              <a href={at("/changelog/rss.xml")} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                <RssIcon aria-hidden /> RSS
              </a>
            </div>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
