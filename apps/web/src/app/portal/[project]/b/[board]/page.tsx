import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NewPostForm } from "@/components/new-post-form";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { VoteButton } from "@/components/vote-button";
import { getSession } from "@/server/session";

export default async function BoardPage(props: PageProps<"/portal/[project]/b/[board]">) {
  const { project: projectSlug, board: boardSlug } = await props.params;
  const session = await getSession();
  const userId = session?.user.id;

  const board = await prisma.board.findFirst({
    where: { slug: boardSlug, project: { slug: projectSlug } },
    include: {
      posts: {
        where: { duplicateOfId: null },
        orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
        take: 100,
        include: {
          author: { select: { name: true } },
          votes: { where: { userId: userId ?? "" }, select: { userId: true } },
        },
      },
    },
  });
  if (!board) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{board.name}</h1>

      {session ? (
        <NewPostForm projectSlug={projectSlug} boardSlug={boardSlug} />
      ) : (
        <p className="text-sm text-muted-foreground">
          <Link href="/sign-in" className="text-foreground underline underline-offset-4">
            Sign in
          </Link>{" "}
          to post feedback and vote.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {board.posts.map((post) => (
          <Card key={post.id} size="sm">
            <CardContent className="flex gap-4">
              <VoteButton
                postId={post.id}
                count={post.voteCount}
                voted={post.votes.length > 0}
                disabled={!session}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-medium">{post.title}</h2>
                {post.body && <p className="line-clamp-2 text-sm text-muted-foreground">{post.body}</p>}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <PostStatusBadge status={post.status} />
                  <span>{post.author.name}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {board.posts.length === 0 && <p className="text-muted-foreground">No feedback yet. Be the first!</p>}
      </div>
    </div>
  );
}
