import { type PostStatus, prisma } from "@tuti/db";
import { CalendarClockIcon, ChevronDownIcon, CircleCheckIcon, HammerIcon, PlusIcon } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { notFound } from "next/navigation";

import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { STATUS_LABELS } from "@/components/post-status-badge";
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
import { SubNav } from "@/components/sub-nav";
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
  // "Share an idea": on the board shown (or the only one), or a pick of them.
  const ideaBoard = board ?? (project.boards.length === 1 ? project.boards[0] : undefined);

  return (
    <div className="flex flex-col gap-6">
      {/* Sharing an idea beside the title: the page's one action. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <PageHeader title="Roadmap" description="What's planned, what we're building and what's done." className="min-w-0" />
        <div className="shrink-0 sm:mt-1">
          {ideaBoard ? (
            <Link href={at(boardPath(ideaBoard))} className={buttonVariants()}>
              <PlusIcon />
              Share an idea
            </Link>
          ) : (
            project.boards.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button />}>
                  <PlusIcon />
                  Share an idea
                  <ChevronDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-40">
                  {project.boards.map((b) => (
                    <DropdownMenuItem key={b.slug} render={<Link href={at(boardPath(b))} />}>
                      {b.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {project.boards.length > 1 ? (
          <ListFilters
            filters={[
              {
                name: "board",
                label: "Board",
                // "*" can't be a board's slug (a board named "All" has "all").
                value: board?.slug ?? "*",
                options: [{ value: "*", label: "All boards" }, ...project.boards.map((b) => ({ value: b.slug, label: b.name }))],
              },
            ]}
          />
        ) : (
          <span />
        )}
        {/* Said on the cards' vote buttons too. */}
        {!voter && (
          <p className="text-sm text-muted-foreground">
            <SignInLink className="text-foreground underline underline-offset-4">Sign in</SignInLink> to vote
          </p>
        )}
      </div>
      {/* Below tablet width, a column at a time. */}
      <SubNav
        label="Columns"
        className="md:hidden"
        current={columnHref(column)}
        scroll={false}
        items={ROADMAP.map(({ status, key }, i) => ({ href: columnHref(key), title: `${STATUS_LABELS[status]} ${columns[i]!.length}` }))}
      />
      {/* Three columns, each headed by its status's icon; a card per idea, the only surface. */}
      <div className="grid gap-x-5 gap-y-10 md:grid-cols-3">
        {ROADMAP.map(({ status, key }, i) => {
          const posts = columns[i]!;
          return (
            <section
              key={status}
              aria-label={STATUS_LABELS[status]}
              aria-describedby={`roadmap-${status}-meaning`}
              className={cn("flex min-w-0 flex-col gap-3", key !== column && "max-md:hidden")}
            >
              <div className="flex flex-col gap-0.5 pb-1">
                {/* Below tablet width the tab over the column names it. */}
                <h2 className="flex items-center gap-2 text-lg font-semibold max-md:sr-only">
                  <ColumnIcon status={status} />
                  {STATUS_LABELS[status]}
                  <span className="font-normal text-muted-foreground tabular-nums">{posts.length}</span>
                </h2>
                <p id={`roadmap-${status}-meaning`} className="text-sm text-muted-foreground">
                  {MEANINGS[status]}
                </p>
              </div>
              {posts.length === 0 ? (
                <p className="rounded-xl border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">Nothing here yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {posts.map((post) => {
                    const entry = entries.get(post.id);
                    return (
                      <li key={post.number} className="flex flex-col gap-1.5 rounded-xl bg-card p-4 shadow-xs ring-1 ring-border">
                        <div className="flex items-start gap-3">
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              {post.board.name} <VisibilityBadge visibility={post.visibility} />
                            </p>
                            <Link href={at(postPath(post))} className="leading-snug font-semibold break-words hover:underline">
                              {post.title}
                            </Link>
                          </div>
                          {status === "COMPLETED" ? (
                            <VoteCount count={post.voteCount} pill />
                          ) : (
                            <VoteButton pill postId={post.id} count={post.voteCount} voted={voted.has(post.id)} disabled={!voter} signedOut={!session} />
                          )}
                        </div>
                        {post.body && <p className="line-clamp-2 text-sm leading-relaxed text-foreground/75">{post.body}</p>}
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Avatar size="sm" aria-hidden className="size-5">
                            {post.author.image && <AvatarImage src={post.author.image} alt="" />}
                            <AvatarFallback className="text-xs">{post.author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          {post.author.name}
                          {entry && (
                            <Link
                              href={at(`/changelog/${entry.number}`)}
                              aria-label={`In the changelog: ${entry.title}`}
                              className="ml-auto font-medium text-foreground hover:underline"
                            >
                              In the changelog
                            </Link>
                          )}
                        </p>
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

/** A column's icon, in its status's colour. */
function ColumnIcon({ status }: { status: (typeof ROADMAP)[number]["status"] }) {
  const Icon = status === "PLANNED" ? CalendarClockIcon : status === "IN_PROGRESS" ? HammerIcon : CircleCheckIcon;
  const colour = status === "PLANNED" ? "text-status-planned" : status === "IN_PROGRESS" ? "text-status-in-progress" : "text-status-completed";
  return <Icon aria-hidden data-status-icon className={`size-[1.125rem] shrink-0 ${colour}`} />;
}
