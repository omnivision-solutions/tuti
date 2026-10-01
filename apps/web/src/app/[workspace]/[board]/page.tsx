import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NewPostForm } from "@/components/new-post-form";
import { VoteButton } from "@/components/vote-button";
import { getSession } from "@/server/session";

export default async function BoardPage(props: PageProps<"/[workspace]/[board]">) {
  const { workspace: workspaceSlug, board: boardSlug } = await props.params;
  const session = await getSession();
  const userId = session?.user.id;

  const board = await prisma.board.findFirst({
    where: { slug: boardSlug, workspace: { slug: workspaceSlug } },
    include: {
      workspace: { select: { name: true } },
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
      <div>
        <p className="text-sm text-zinc-500">{board.workspace.name}</p>
        <h1 className="text-2xl font-semibold">{board.name}</h1>
      </div>

      {session ? (
        <NewPostForm workspaceSlug={workspaceSlug} boardSlug={boardSlug} />
      ) : (
        <p className="text-sm text-zinc-500">
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>{" "}
          to post feedback and vote.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {board.posts.map((post) => (
          <li key={post.id} className="flex gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <VoteButton
              postId={post.id}
              count={post.voteCount}
              voted={post.votes.length > 0}
              disabled={!session}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-medium">{post.title}</h2>
              {post.body && <p className="line-clamp-2 text-sm text-zinc-500">{post.body}</p>}
              <p className="text-xs text-zinc-400">
                {post.author.name} · {post.status.replace("_", " ").toLowerCase()}
              </p>
            </div>
          </li>
        ))}
        {board.posts.length === 0 && <p className="text-zinc-500">No feedback yet. Be the first!</p>}
      </ul>
    </div>
  );
}
