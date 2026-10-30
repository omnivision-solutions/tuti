import { prisma } from "@tuti/db";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { PostStatusMenu } from "@/components/post-status-select";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { portalAddress } from "@/server/custom-domains";
import { sortFilter, statusFilter } from "@/lib/post-filter-options";
import { nextPageHref, parsePostFilters } from "@/lib/post-filters";
import { teamPosts } from "@/server/post-lists";

export default async function FeedbackPage(props: PageProps<"/app/[project]/feedback">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const filters = parsePostFilters(searchParams);
  const duplicatesOnly = searchParams.show === "duplicates";
  const project = await prisma.project.findUniqueOrThrow({
    where: { slug },
    select: { id: true, boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } } },
  });
  const { posts, more } = await teamPosts(project.id, filters, duplicatesOnly);
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

      {posts.length === 0 ? (
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
              {posts.map((post) => (
                <ItemRow
                  key={post.id}
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
                      #{post.number} · {post.board.name} · {post.author.name}
                      {post.commentCount > 0 &&
                        ` · ${post.commentCount} ${post.commentCount === 1 ? "comment" : "comments"}`}
                    </>
                  }
                  actions={<PostStatusMenu projectSlug={slug} postId={post.id} status={post.status} />}
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
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
    </>
  );
}
