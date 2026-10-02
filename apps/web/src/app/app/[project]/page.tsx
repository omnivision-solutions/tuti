import { prisma } from "@tuti/db";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { ListFilters } from "@/components/list-filters";
import { MovePostSelect } from "@/components/move-post-select";
import { PostStatusSelect } from "@/components/post-status-select";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";
import { sortFilter, statusFilter } from "@/lib/post-filter-options";
import { parsePostFilters, postOrderBy } from "@/lib/post-filters";

/** Pending suggestions that this post duplicates an older post that's still listed. */
const possibleDuplicateOf = { status: "PENDING", original: { duplicateOfId: null } } as const;

export default async function FeedbackPage(props: PageProps<"/app/[project]">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const filters = parsePostFilters(searchParams);
  const duplicatesOnly = searchParams.show === "duplicates";
  const project = await prisma.project.findUniqueOrThrow({
    where: { slug },
    select: {
      boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } },
      posts: {
        where: {
          duplicateOfId: null,
          ...(filters.status && { status: filters.status }),
          ...(filters.board && { board: { slug: filters.board } }),
          ...(duplicatesOnly && { duplicateSuggestions: { some: possibleDuplicateOf } }),
        },
        orderBy: postOrderBy(filters.sort),
        take: 100,
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          voteCount: true,
          commentCount: true,
          board: { select: { slug: true } },
          author: { select: { name: true } },
          _count: { select: { duplicateSuggestions: { where: possibleDuplicateOf } } },
        },
      },
    },
  });
  const portal = portalUrl(slug);
  const filtered = Boolean(filters.status || filters.board || duplicatesOnly);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
          <p className="text-sm text-muted-foreground">Everything your users have posted.</p>
        </div>
        <a
          href={portal}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm", className: "max-w-full self-start" })}
        >
          <ExternalLinkIcon />
          {new URL(portal).host}
        </a>
      </div>

      <ListFilters
        filters={[
          {
            name: "board",
            label: "Board",
            value: project.boards.some((b) => b.slug === filters.board) ? filters.board! : "all",
            options: [{ value: "all", label: "All boards" }, ...project.boards.map((b) => ({ value: b.slug, label: b.name }))],
          },
          statusFilter(filters.statusParam),
          sortFilter(filters.sort),
          {
            name: "show",
            label: "Show",
            value: duplicatesOnly ? "duplicates" : "all",
            options: [
              { value: "all", label: "All posts" },
              { value: "duplicates", label: "Possible duplicates" },
            ],
          },
        ]}
      />

      {project.posts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{filtered ? "No posts match these filters" : "No feedback yet"}</CardTitle>
            <CardDescription>
              {filtered
                ? "Try other filters."
                : "Share your portal with users, or connect your app with single sign-on in Settings."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card size="sm">
          <CardContent className="flex flex-col divide-y">
            {project.posts.map((post) => (
              <div
                key={post.id}
                className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{post.voteCount}</span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
                      <Link
                        href={`/app/${slug}/p/${post.number}`}
                        className="min-w-0 font-medium break-words hover:underline sm:truncate"
                      >
                        {post.title}
                      </Link>
                      {post._count.duplicateSuggestions > 0 && (
                        <Badge variant="outline" className="shrink-0">
                          Possible duplicate
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      #{post.number} · {post.author.name}
                      {post.commentCount > 0 && ` · ${post.commentCount} ${post.commentCount === 1 ? "comment" : "comments"}`}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <MovePostSelect
                    projectSlug={slug}
                    postId={post.id}
                    boardSlug={post.board.slug}
                    boards={project.boards}
                    className="w-full max-w-none sm:w-auto sm:max-w-40"
                  />
                  <PostStatusSelect projectSlug={slug} postId={post.id} status={post.status} className="w-full sm:w-36" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
