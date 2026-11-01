import { type PostStatus, prisma } from "@tuti/db";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { SignInLink } from "@/components/sign-in-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { VoteButton } from "@/components/vote-button";
import { boardPath, postPath } from "@/lib/post-urls";
import { ROADMAP, roadmapColumns } from "@/server/operations/read";
import { portalLinks } from "@/server/portal-base";
import { getSession } from "@/server/session";

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
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } } },
  });
  if (!project) {
    notFound();
  }
  const session = await getSession();
  const board = project.boards.find((b) => b.slug === searchParams.board);
  const columns = await roadmapColumns(project.id, { board: board?.slug });
  const ids = columns.flat().map((post) => post.id);
  const [votes, shipped] = await Promise.all([
    session ? prisma.vote.findMany({ where: { userId: session.user.id, postId: { in: ids } }, select: { postId: true } }) : [],
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
  // "Share an idea": on the board shown (or the only one), or a pick of them.
  const ideaBoard = board ?? (project.boards.length === 1 ? project.boards[0] : undefined);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Roadmap" description="What's planned, what we're building and what's done." />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {project.boards.length > 1 ? (
          <ListFilters
            filters={[
              {
                name: "board",
                label: "Board",
                value: board?.slug ?? "all",
                options: [{ value: "all", label: "All boards" }, ...project.boards.map((b) => ({ value: b.slug, label: b.name }))],
              },
            ]}
          />
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-3">
          {/* The cards' vote buttons only say so on hover. */}
          {!session && (
            <p className="text-sm text-muted-foreground">
              <SignInLink className="text-foreground underline underline-offset-4">Sign in</SignInLink> to vote
            </p>
          )}
          {ideaBoard ? (
            <Link href={at(boardPath(ideaBoard))} className={buttonVariants({ size: "sm" })}>
              <PlusIcon />
              Share an idea
            </Link>
          ) : (
            project.boards.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="sm" />}>
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
      <div className="grid gap-6 md:grid-cols-3">
        {ROADMAP.map(({ status }, i) => {
          const posts = columns[i]!;
          return (
            <section key={status} aria-label={STATUS_LABELS[status]} aria-describedby={`roadmap-${status}-meaning`} className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h2 className="flex items-center gap-2 font-medium">
                  <StatusDot status={status} />
                  {STATUS_LABELS[status]}
                  <span className="text-sm font-normal text-muted-foreground">{posts.length}</span>
                </h2>
                <p id={`roadmap-${status}-meaning`} className="text-sm text-muted-foreground">
                  {MEANINGS[status]}
                </p>
              </div>
              {posts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing here yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {posts.map((post) => {
                    const entry = entries.get(post.id);
                    return (
                      <li key={post.number} className="flex items-start gap-3 rounded-xl border bg-card p-3 text-sm">
                        <VoteButton postId={post.id} count={post.voteCount} voted={voted.has(post.id)} disabled={!session} />
                        <div className="flex min-w-0 flex-col gap-1">
                          <Link href={at(postPath(post))} className="font-medium break-words hover:underline">
                            {post.title}
                          </Link>
                          <p className="text-xs text-muted-foreground">{post.board.name}</p>
                          {entry && (
                            <p className="text-xs text-muted-foreground">
                              Shipped in{" "}
                              <Link href={at(`/changelog/${entry.number}`)} className="text-foreground hover:underline">
                                {entry.title}
                              </Link>
                            </p>
                          )}
                        </div>
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
