import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { ListFilters } from "@/components/list-filters";
import { NewPostDialog } from "@/components/new-post-form";
import { PageHeader } from "@/components/page-header";
import { PostStatusBadge } from "@/components/post-status-badge";
import { SignInLink } from "@/components/sign-in-link";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { VoteButton } from "@/components/vote-button";
import { boardTexts } from "@/lib/board-texts";
import { sortFilter, statusFilter } from "@/lib/post-filter-options";
import { nextPageHref, parsePostFilters } from "@/lib/post-filters";
import { boardPath, postPath } from "@/lib/post-urls";
import { portalAddress } from "@/server/custom-domains";
import { getSession } from "@/server/session";
import { portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";
import { boardPosts } from "@/server/post-lists";

/** Sorted or filtered (`?sort=`, `?status=`), it's still the board: one address for search engines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/feedback/[board]">): Promise<Metadata> {
  const { project, board } = await props.params;
  return { alternates: { canonical: `${await portalAddress(project)}${boardPath({ slug: board })}` } };
}

export default async function BoardPage(props: PageProps<"/portal/[project]/feedback/[board]">) {
  const at = await portalLinks();
  const { project: projectSlug, board: boardSlug } = await props.params;
  const searchParams = await props.searchParams;
  const filters = parsePostFilters(searchParams);
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

  const { posts, more } = await boardPosts(board.id, filters, userId);
  const { postButton, ...placeholders } = boardTexts(board);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={board.name}
        description={board.description}
        actions={
          session && (
            <NewPostDialog
              label={postButton}
              projectSlug={projectSlug}
              boardSlug={boardSlug}
              mediaUrls={await mediaUrls()}
              defaultTitle={title}
              {...placeholders}
            />
          )
        }
      />

      {!session && (
        <p className="text-sm text-muted-foreground">
          <SignInLink className="text-foreground underline underline-offset-4">
            Sign in
          </SignInLink>{" "}
          to post feedback and vote.
        </p>
      )}

      <ListFilters filters={[sortFilter(filters.sort), statusFilter(filters.statusParam)]} />

      <div className="flex flex-col gap-3">
        {posts.map((post) => (
          <Card key={post.id} size="sm">
            <CardContent className="flex gap-4">
              <VoteButton
                postId={post.id}
                count={post.voteCount}
                voted={post.votes.length > 0}
                disabled={!session}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-medium">
                  <Link href={at(postPath({ ...post, board }))} className="hover:underline">
                    {post.title}
                  </Link>
                </h2>
                {post.body && <p className="line-clamp-2 text-sm text-muted-foreground">{post.body}</p>}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <PostStatusBadge status={post.status} />
                  <span>{post.author.name}</span>
                  {post.commentCount > 0 && (
                    <span>
                      · {post.commentCount} {post.commentCount === 1 ? "comment" : "comments"}
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {posts.length === 0 && (
          <EmptyState
            title={filters.status ? "No posts with this status yet" : "No feedback yet"}
            description={filters.status ? "Try another status." : "Be the first to share an idea."}
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
    </div>
  );
}
