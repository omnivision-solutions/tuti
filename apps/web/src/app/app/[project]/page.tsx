import { prisma } from "@tuti/db";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { ListFilters } from "@/components/list-filters";
import { MovePostSelect } from "@/components/move-post-select";
import { PageHeader } from "@/components/page-header";
import { PostStatusSelect } from "@/components/post-status-select";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { portalAddress } from "@/server/custom-domains";
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
  const portal = await portalAddress(slug);
  const filtered = Boolean(filters.status || filters.board || duplicatesOnly);

  return (
    <>
      <PageHeader
        title="Feedback"
        description="Everything your users have posted."
        actions={
          <a
            href={portal}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline", size: "sm", className: "max-w-full" })}
          >
            <ExternalLinkIcon />
            <span className="truncate">{new URL(portal).host}</span>
          </a>
        }
      />

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
        <EmptyState
          title={filtered ? "No posts match these filters" : "No feedback yet"}
          description={
            filtered
              ? "Try other filters."
              : "Share your portal with users, or connect your app with single sign-on in Settings."
          }
        />
      ) : (
        <Card size="sm">
          <CardContent>
            <ItemList>
              {project.posts.map((post) => (
                <ItemRow
                  key={post.id}
                  wideActions
                  leading={<span className="w-8 shrink-0 text-right font-semibold tabular-nums">{post.voteCount}</span>}
                  title={
                    <Link href={`/app/${slug}/p/${post.number}`} className="hover:underline">
                      {post.title}
                    </Link>
                  }
                  badges={
                    post._count.duplicateSuggestions > 0 && <Badge variant="highlight">Possible duplicate</Badge>
                  }
                  meta={
                    <>
                      #{post.number} · {post.author.name}
                      {post.commentCount > 0 &&
                        ` · ${post.commentCount} ${post.commentCount === 1 ? "comment" : "comments"}`}
                    </>
                  }
                  actions={
                    <>
                      <MovePostSelect
                        projectSlug={slug}
                        postId={post.id}
                        boardSlug={post.board.slug}
                        boards={project.boards}
                        className="w-full max-w-none sm:w-auto sm:max-w-40"
                      />
                      <PostStatusSelect
                        projectSlug={slug}
                        postId={post.id}
                        status={post.status}
                        className="w-full sm:w-36"
                      />
                    </>
                  }
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
    </>
  );
}
