import { type PostStatus, prisma } from "@tuti/db";
import { ArrowRightIcon, CalendarIcon, CheckIcon, ChevronDownIcon, LayoutListIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";

import { PortalAvatar } from "@/components/portal-avatar";
import { etaOnPortal, formatMonth } from "@/lib/format";
import { notFound } from "next/navigation";

import { STATUS_ICONS, STATUS_LABELS, STATUS_TEXT } from "@/components/post-status-badge";
import { SignInLink } from "@/components/sign-in-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { VoteButton, VoteCount } from "@/components/vote-button";
import { boardPath, postPath } from "@/lib/post-urls";
import { canActIn } from "@/server/membership";
import { ROADMAP, roadmapColumns } from "@/server/operations/read";
import { portalLinks } from "@/server/portal-base";
import { getSession } from "@/server/session";
import { currentPostViewer } from "@/server/portal-access";
import { VisibilityBadge } from "@/components/visibility-badge";
import { cn } from "@/lib/utils";
import { shownBoards } from "@/server/post-visibility";

/** What each column means, under its name. */
const MEANINGS: Partial<Record<PostStatus, string>> = {
  PLANNED: "We've decided to build these.",
  IN_PROGRESS: "We're building these now.",
  COMPLETED: "Shipped and ready to use.",
};

/** What's planned, being built and done, from the posts' statuses; a board at a time (`?board=`), voted on from the cards. */
export default async function RoadmapPage(props: PageProps<"/portal/[project]/roadmap">) {
  const at = await portalLinks();
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const found = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  if (!found) {
    notFound();
  }
  // The posts they may see, on the boards they may (post-visibility.ts).
  const viewer = await currentPostViewer(found.id);
  const project = {
    id: found.id,
    boards: await prisma.board.findMany({ where: { projectId: found.id, ...shownBoards(viewer) }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } }),
  };
  const session = await getSession();
  // As voting checks it: someone signed in through another project's single sign-on can't vote here.
  const voter = session && (await canActIn(session.user.id, project.id)) ? session.user.id : null;
  const board = project.boards.find((b) => b.slug === searchParams.board);
  const columns = await roadmapColumns(project.id, viewer, { board: board?.slug });
  const ids = columns.flat().map((post) => post.id);
  const [votes, shipped] = await Promise.all([
    voter ? prisma.vote.findMany({ where: { userId: voter, postId: { in: ids } }, select: { postId: true } }) : [],
    // The published changelog entry that shipped each completed one, the latest first (as on the post's page).
    prisma.changelogEntryPost.findMany({
      where: { postId: { in: columns[ROADMAP.length - 1]!.map((post) => post.id) }, entry: { publishedAt: { not: null } } },
      orderBy: { entry: { publishedAt: "desc" } },
      select: { postId: true, entry: { select: { number: true, title: true } } },
    }),
  ]);
  const voted = new Set(votes.map((vote) => vote.postId));
  const entries = new Map<string, { number: number; title: string }>();
  for (const { postId, entry } of shipped) {
    if (!entries.has(postId)) {
      entries.set(postId, entry);
    }
  }
  // On phones one column at a time (`?column=`, Planned first), picked from tabs over it; wider, all three.
  const column = ROADMAP.find((c) => c.key === searchParams.column)?.key ?? "planned";
  const columnHref = (key: string) => {
    const params = new URLSearchParams({ ...(board && { board: board.slug }), ...(key !== "planned" && { column: key }) });
    return params.size > 0 ? `${at("/roadmap")}?${params}` : at("/roadmap");
  };
  // New idea: on the board shown (or the only one), or a pick of them.
  const ideaBoard = board ?? (project.boards.length === 1 ? project.boards[0] : undefined);
  // A board's chip keeps the column open on phones (`?column=`).
  const boardHref = (slug?: string) => {
    const params = new URLSearchParams({ ...(slug && { board: slug }), ...(column !== "planned" && { column }) });
    return params.size > 0 ? `${at("/roadmap")}?${params}` : at("/roadmap");
  };
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      {/* New idea beside the title: the page's one action; the line under both. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-heading text-[2.25rem] leading-tight font-[650] tracking-[-0.022em] sm:text-5xl">Roadmap</h1>
          <div className="shrink-0">
            {ideaBoard ? (
              <Link href={`${at(boardPath(ideaBoard))}?new`} className={buttonVariants({ size: "lg", className: "font-semibold" })}>
                <PlusIcon />
                New idea
              </Link>
            ) : (
              project.boards.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="lg" className="font-semibold" />}>
                    <PlusIcon />
                    New idea
                    <ChevronDownIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-auto min-w-40">
                    {project.boards.map((b) => (
                      <DropdownMenuItem key={b.slug} render={<Link href={`${at(boardPath(b))}?new`} />}>
                        {b.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            )}
          </div>
        </div>
        <p className="text-base text-muted-foreground sm:text-lg">
          What&apos;s planned, what we&apos;re building and what&apos;s done.
          {/* Said on the cards' vote buttons too. */}
          {!voter && (
            <>
              {" "}
              <SignInLink className="font-medium text-foreground underline decoration-primary/55 decoration-[1.5px] underline-offset-[3px]">Sign in</SignInLink> to
              vote.
            </>
          )}
        </p>
      </div>
      {/* The boards, one at a time or all: chips (wrapping on phones). */}
      {project.boards.length > 1 && (
        <nav aria-label="Board" className="flex flex-wrap gap-2">
          {[{ slug: undefined, name: "All boards" }, ...project.boards].map((b) => {
            const active = b.slug === board?.slug;
            return (
              <Link
                key={b.slug ?? "*"}
                href={boardHref(b.slug)}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center rounded-full border px-4 text-[0.9375rem] font-medium whitespace-nowrap transition-colors",
                  active ? "border-primary/40 bg-soft text-soft-foreground" : "border-input bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {b.name}
              </Link>
            );
          })}
        </nav>
      )}
      {/* Below tablet width, a column at a time, picked from a segmented control. */}
      <nav aria-label="Columns" className="flex rounded-xl bg-muted p-1 ring-1 ring-border md:hidden">
        {ROADMAP.map(({ status, key }, i) => {
          const active = key === column;
          return (
            <Link
              key={key}
              href={columnHref(key)}
              scroll={false}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-semibold whitespace-nowrap",
                active ? "bg-card text-foreground shadow-card ring-1 ring-border" : "text-muted-foreground",
              )}
            >
              <span className="truncate">{STATUS_LABELS[status]}</span>{" "}
              <span className="text-xs font-semibold text-muted-foreground tabular-nums">{columns[i]!.length}</span>
            </Link>
          );
        })}
      </nav>
      {/* Three columns, each headed by its status's icon; a card per idea. */}
      <div className="grid gap-x-10 gap-y-10 border-t pt-2 max-md:border-t-0 max-md:pt-0 md:grid-cols-3">
        {ROADMAP.map(({ status, key }, i) => {
          const posts = columns[i]!;
          const Icon = STATUS_ICONS[status];
          return (
            <section
              key={status}
              aria-label={STATUS_LABELS[status]}
              aria-describedby={`roadmap-${status}-meaning`}
              className={cn("flex min-w-0 flex-col gap-3", key !== column && "max-md:hidden")}
            >
              <div className="flex flex-col gap-1 border-b pt-4 pb-4 max-md:border-b-0 max-md:pt-0 max-md:pb-0">
                {/* Below tablet width the control over the column names it. */}
                <h2 className="flex items-center gap-2.5 font-heading text-[1.1875rem] font-[650] tracking-[-0.01em] max-md:sr-only">
                  <Icon aria-hidden data-status-icon className={cn("size-5 shrink-0", STATUS_TEXT[status])} />
                  {STATUS_LABELS[status]}
                  <span className="font-sans text-base font-medium text-muted-foreground tabular-nums">{posts.length}</span>
                </h2>
                <p id={`roadmap-${status}-meaning`} className="text-[0.9375rem] text-muted-foreground max-md:hidden">
                  {MEANINGS[status]}
                </p>
              </div>
              {posts.length === 0 ? (
                <p className="rounded-xl border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">Nothing here yet.</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {posts.map((post) => {
                    const entry = entries.get(post.id);
                    const eta = post.eta && etaOnPortal(post.eta, post.status, now) ? post.eta : null;
                    return (
                      <li key={post.number} className="flex flex-col rounded-xl bg-card p-4 shadow-card ring-1 ring-border sm:px-5">
                        <p className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] font-medium text-muted-foreground">
                          <LayoutListIcon aria-hidden className="size-3.5" />
                          {post.board.name} <VisibilityBadge visibility={post.visibility} />
                        </p>
                        <Link href={at(postPath(post))} className="mt-1.5 text-base leading-snug font-[650] tracking-[-0.01em] break-words hover:underline">
                          {post.title}
                        </Link>
                        {post.body && <p className="mt-1 line-clamp-2 text-[0.9375rem] leading-relaxed text-muted-foreground">{post.body}</p>}
                        {eta && (
                          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                            <CalendarIcon aria-hidden className="size-3.5" />
                            Expected {formatMonth(eta)}
                          </p>
                        )}
                        <div className="mt-3 flex items-center gap-2.5 text-sm text-muted-foreground">
                          <PortalAvatar person={post.author} className="size-6 text-xs" />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">{post.author.name}</span>
                          {post.commentCount > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <MessageSquareIcon aria-hidden className="size-3.5" />
                              <span aria-hidden>{post.commentCount}</span>
                              <span className="sr-only">
                                {post.commentCount} {post.commentCount === 1 ? "comment" : "comments"}
                              </span>
                            </span>
                          )}
                          {status === "COMPLETED" ? (
                            <VoteCount count={post.voteCount} shape="chip" />
                          ) : (
                            <VoteButton shape="chip" postId={post.id} count={post.voteCount} voted={voted.has(post.id)} disabled={!voter} signedOut={!session} />
                          )}
                        </div>
                        {entry && (
                          <Link
                            href={at(`/changelog/${entry.number}`)}
                            aria-label={`In the changelog: ${entry.title}`}
                            className="mt-3 inline-flex items-center gap-1.5 self-start text-sm font-semibold text-soft-foreground hover:underline"
                          >
                            <CheckIcon aria-hidden className="size-3.5" />
                            In the changelog
                            <ArrowRightIcon aria-hidden className="size-3.5" />
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
