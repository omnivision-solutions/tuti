import { prisma } from "@tuti/db";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { ListFilters } from "@/components/list-filters";
import { MovePostSelect } from "@/components/move-post-select";
import { PostStatusSelect } from "@/components/post-status-select";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";
import { sortFilter, statusFilter } from "@/lib/post-filter-options";
import { parsePostFilters, postOrderBy } from "@/lib/post-filters";

export default async function FeedbackPage(props: PageProps<"/app/[project]">) {
  const { project: slug } = await props.params;
  const filters = parsePostFilters(await props.searchParams);
  const project = await prisma.project.findUniqueOrThrow({
    where: { slug },
    select: {
      boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } },
      posts: {
        where: {
          duplicateOfId: null,
          ...(filters.status && { status: filters.status }),
          ...(filters.board && { board: { slug: filters.board } }),
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
        },
      },
    },
  });
  const portal = portalUrl(slug);
  const filtered = Boolean(filters.status || filters.board);

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
          <p className="text-sm text-muted-foreground">Everything your users have posted.</p>
        </div>
        <a href={portal} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
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
        ]}
      />

      {project.posts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{filtered ? "No posts match these filters" : "No feedback yet"}</CardTitle>
            <CardDescription>
              {filtered
                ? "Try another board or status."
                : "Share your portal with users, or connect your app with single sign-on in Settings."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card size="sm">
          <CardContent className="flex flex-col divide-y">
            {project.posts.map((post) => (
              <div key={post.id} className="flex items-center gap-4 py-2.5 first:pt-0 last:pb-0">
                <span className="w-10 text-right font-semibold tabular-nums">{post.voteCount}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <Link href={`/app/${slug}/p/${post.number}`} className="truncate font-medium hover:underline">
                    {post.title}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    #{post.number} · {post.author.name}
                    {post.commentCount > 0 && ` · ${post.commentCount} ${post.commentCount === 1 ? "comment" : "comments"}`}
                  </span>
                </div>
                <MovePostSelect
                  projectSlug={slug}
                  postId={post.id}
                  boardSlug={post.board.slug}
                  boards={project.boards}
                />
                <PostStatusSelect projectSlug={slug} postId={post.id} status={post.status} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
