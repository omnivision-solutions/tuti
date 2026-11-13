import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { ArrowRightIcon, CircleCheckIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { boardGetUpdates } from "@/components/board-get-updates";
import { BoardSearch } from "@/components/board-search";
import { EmptyState } from "@/components/empty-state";
import { NewPostMenu } from "@/components/new-post-menu";
import { FilterPills } from "@/components/filter-pills";
import { PortalPageHeader } from "@/components/portal-page-header";
import { StatusLabel } from "@/components/post-status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VoteButton, VoteCount } from "@/components/vote-button";
import { formatDay } from "@/lib/format";
import { ACTIVE_STATUSES, nextPageHref, parsePostFilters, TEAM_SORTS } from "@/lib/post-filters";
import { boardPath, postPath } from "@/lib/post-urls";
import { portalAddress } from "@/server/custom-domains";
import { canActIn } from "@/server/membership";
import { currentPostViewer } from "@/server/portal-access";
import { portalLinks } from "@/server/portal-base";
import { boardPosts, boardsWithCounts, recentlyShipped } from "@/server/post-lists";
import { getSession } from "@/server/session";

/** How many open ideas each board's card shows, and how many shipped ones are listed under the cards. */
const TOP_IDEAS = 3;
const SHIPPED_SHOWN = 3;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Searched (`?q=`), it's still the overview: one address for search engines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/feedback">): Promise<Metadata> {
  const { project } = await props.params;
  return { alternates: { canonical: `${await portalAddress(project)}/feedback` } };
}

/**
 * Feedback: every board the reader sees, each a card with its top open ideas (Trending's order) and how many more, then
 * what shipped lately. With one board there's nothing to choose: it opens that board. `?q=` searches every board.
 */
export default async function FeedbackOverview(props: PageProps<"/portal/[project]/feedback">) {
  const at = await portalLinks();
  const { project: slug } = await props.params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, name: true, slug: true, portalAccess: true } });
  if (!project) {
    notFound();
  }
  const viewer = await currentPostViewer(project.id);
  const boards = await boardsWithCounts(project.id, viewer);
  if (boards.length === 0) {
    notFound();
  }
  if (boards.length === 1) {
    redirect(at(boardPath(boards[0]!)));
  }
  const searchParams = await props.searchParams;
  const q = first(searchParams.q)?.trim().slice(0, 255) || undefined;
  const session = await getSession();
  // As voting checks it: someone signed in through another project's single sign-on can't vote here.
  const voter = session && (await canActIn(session.user.id, project.id)) ? session.user.id : null;
  const filters = parsePostFilters(searchParams, TEAM_SORTS, "trending");
  const bySlug = new Map(boards.map((board) => [board.slug, board]));

  const [found, tops, shipped, getUpdates] = await Promise.all([
    // A search: every board's ideas they see, every status (as a board's search), Trending's order; only on the boards shown.
    q ? boardPosts({ projectId: project.id }, filters, viewer, { q, boardIds: boards.map((board) => board.id) }) : null,
    // ponytail: a board's first page read for its top three; give boardPosts a limit if boards get many ideas.
    q ? [] : Promise.all(boards.map(async (board) => (await boardPosts({ projectId: project.id, slug: board.slug }, { ...filters, page: 1 }, viewer, { statuses: ACTIVE_STATUSES })).posts.slice(0, TOP_IDEAS))),
    q ? [] : Promise.all(boards.map(async (board) => (await recentlyShipped(board.id, viewer)).map((post) => ({ ...post, board })))),
    boardGetUpdates({ project, session, voter, back: "/feedback" }),
  ]);
  const results = found;
  const latest = shipped
    .flat()
    .sort((a, b) => b.shippedAt.getTime() - a.shippedAt.getTime())
    .slice(0, SHIPPED_SHOWN);
  const total = boards.reduce((sum, board) => sum + board._count.posts, 0);

  const vote = (post: { id: string; status: string; voteCount: number; votes: unknown[] }, shape: "chip" | "box") =>
    post.status === "COMPLETED" ? (
      <VoteCount count={post.voteCount} shape={shape} />
    ) : (
      <VoteButton shape={shape} postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!voter} signedOut={!session} />
    );
  const search = (className?: string) => <BoardSearch action={at("/feedback")} q={q ?? ""} className={className} />;
  const newPost = (round: boolean) => <NewPostMenu round={round} boards={boards.map((board) => ({ ...board, href: `${at(boardPath(board))}?new` }))} />;

  return (
    <div className="flex flex-col gap-8">
      <PortalPageHeader
        title="Feedback"
        description="Vote for the ideas you want most, or share your own."
        pills={
          <FilterPills
            label="Boards"
            current={at("/feedback")}
            items={[
              { title: "All boards", href: at("/feedback"), count: total },
              ...boards.map((board) => ({ title: board.name, href: at(boardPath(board)), count: board._count.posts })),
            ]}
          />
        }
        actions={
          <>
            <div className="w-60">{search("h-9 sm:h-9 rounded-[0.625rem]")}</div>
            {getUpdates(true)}
            {newPost(false)}
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
            {newPost(true)}
          </>
        }
      />

      {results ? (
        <section aria-label="Ideas" className="flex flex-col gap-6">
          {/* What a search found, read out (the page doesn't reload, so nothing else is). */}
          <p role="status" className="sr-only">
            {results.posts.length === 0 ? `No ideas match "${q}"` : `${results.posts.length}${results.more ? "+" : ""} ${results.posts.length === 1 && !results.more ? "idea matches" : "ideas match"} "${q}"`}
          </p>
          {results.posts.length === 0 ? (
            <EmptyState title="No ideas match" description="Try other words, or post it on one of the boards." />
          ) : (
            <ul className="flex flex-col divide-y border-b">
              {results.posts.map((post) => {
                const board = bySlug.get(post.board.slug)!;
                return (
                  <li key={post.id} className="flex items-start gap-4 py-5">
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      {post.status !== "OPEN" && <StatusLabel status={post.status} />}
                      <h2 className="font-sans text-base leading-snug font-[650] break-words">
                        <Link href={at(postPath({ ...post, board }))} className="hover:underline">
                          {post.title}
                        </Link>
                      </h2>
                      <p className="text-[0.84375rem] text-muted-foreground">{board.name}</p>
                    </div>
                    {vote(post, "box")}
                  </li>
                );
              })}
            </ul>
          )}
          {results.more && (
            <Link href={nextPageHref(searchParams, filters)} scroll={false} className={buttonVariants({ variant: "outline", className: "self-center" })}>
              Load more
            </Link>
          )}
        </section>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {boards.map((board, i) => {
              const ideas = tops[i]!;
              return (
                <section
                  key={board.id}
                  aria-labelledby={`board-${board.id}`}
                  className="flex flex-col gap-4 rounded-[0.875rem] bg-card p-5 shadow-card ring-1 ring-card-edge sm:p-6"
                >
                  <div className="flex flex-col gap-0.5">
                    <h2 id={`board-${board.id}`} className="font-heading text-lg leading-snug font-[650] break-words">
                      {board.name}
                    </h2>
                    {board.description && <p className="text-sm text-muted-foreground">{board.description}</p>}
                  </div>
                  {ideas.length > 0 ? (
                    <ul className="flex flex-col gap-2.5">
                      {ideas.map((post) => (
                        <li key={post.id} className="flex items-center gap-3">
                          {vote(post, "chip")}
                          <Link href={at(postPath({ ...post, board }))} className="min-w-0 flex-1 truncate text-[0.9375rem] hover:underline">
                            {post.title}
                          </Link>
                          {post.status !== "OPEN" && <StatusLabel status={post.status} className="shrink-0" />}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No ideas yet. Be the first to share one.</p>
                  )}
                  <div className="mt-auto flex items-center justify-between gap-3 pt-1 text-sm">
                    <span className="text-muted-foreground">
                      {board._count.posts} {board._count.posts === 1 ? "idea" : "ideas"} still to come
                    </span>
                    <Link href={at(boardPath(board))} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      Open board
                      <ArrowRightIcon aria-hidden className="size-3.5" />
                    </Link>
                  </div>
                </section>
              );
            })}
          </div>
          {latest.length > 0 && (
            <section aria-labelledby="recently-shipped" className="flex flex-col gap-1">
              <h2 id="recently-shipped" className="text-[0.8125rem] font-medium text-muted-foreground">
                Recently shipped
              </h2>
              <ul className="flex flex-col divide-y border-b">
                {latest.map((post) => (
                  <li key={post.id} className="flex items-center gap-3 py-3">
                    <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-status-completed" />
                    <Link href={at(postPath({ ...post, board: post.board }))} className="min-w-0 flex-1 truncate text-[0.9375rem] hover:underline">
                      {post.title}
                    </Link>
                    <span className="shrink-0 text-sm text-muted-foreground">{formatDay(post.shippedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {/* Phones: the header's row has no room for it. */}
      <div className="sm:hidden">{getUpdates(false)}</div>
    </div>
  );
}
