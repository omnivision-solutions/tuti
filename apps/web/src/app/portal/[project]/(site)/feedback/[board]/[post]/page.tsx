import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { PostStatusBadge } from "@/components/post-status-badge";
import { SignInLink } from "@/components/sign-in-link";
import { Separator } from "@/components/ui/separator";
import { VoteButton } from "@/components/vote-button";
import { timeAgo } from "@/lib/format";
import { boardPath, postNumberFromParam, postPath } from "@/lib/post-urls";
import { getSession } from "@/server/session";
import { isEmptyDoc } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { displayDoc } from "@/server/content";

export default async function PortalPostPage(props: PageProps<"/portal/[project]/feedback/[board]/[post]">) {
  const { project: projectSlug, board: boardParam, post: param } = await props.params;
  const number = postNumberFromParam(param);
  if (number === null) {
    notFound();
  }
  const session = await getSession();

  const post = await prisma.post.findFirst({
    where: { number, project: { slug: projectSlug } },
    include: {
      board: { select: { slug: true, name: true } },
      author: { select: { id: true, name: true } },
      votes: { where: { userId: session?.user.id ?? "" }, select: { userId: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, content: true, createdAt: true, author: { select: { id: true, name: true, image: true } } },
      },
      project: { select: { team: { select: { userId: true } } } },
      duplicateOf: { select: { number: true, title: true, board: { select: { slug: true } } } },
      // The published changelog entry that shipped it, if any.
      changelogEntries: {
        where: { entry: { publishedAt: { not: null } } },
        orderBy: { entry: { publishedAt: "desc" } },
        take: 1,
        select: { entry: { select: { number: true, title: true } } },
      },
    },
  });
  if (!post) {
    notFound();
  }
  // Merged into another post: that's where its votes and comments are now.
  if (post.duplicateOf) {
    permanentRedirect(postPath(post.duplicateOf));
  }
  // Retitled or moved to another board since the link was made: send to the current URL.
  if (`/feedback/${boardParam}/${param}` !== postPath(post)) {
    permanentRedirect(postPath(post));
  }
  const teamUserIds = new Set(post.project.team.map((m) => m.userId));

  return (
    <div className="flex flex-col gap-6">
      <BackLink href={boardPath(post.board)}>{post.board.name}</BackLink>

      <article className="flex items-start gap-4">
        <VoteButton postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!session} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight break-words">{post.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <PostStatusBadge status={post.status} />
            <span>{post.author.name}</span>
            <span>·</span>
            <time dateTime={post.createdAt.toISOString()}>{timeAgo(post.createdAt)}</time>
          </div>
          {post.changelogEntries[0] && (
            <p className="text-sm text-muted-foreground">
              Shipped in{" "}
              <Link href={`/changelog/${post.changelogEntries[0].entry.number}`} className="text-foreground hover:underline">
                {post.changelogEntries[0].entry.title}
              </Link>
            </p>
          )}
          {!isEmptyDoc(displayDoc(post)) && (
            <RichText doc={displayDoc(post)} mediaBaseUrl={mediaPublicUrl()} className="rich-text break-words" />
          )}
        </div>
      </article>

      <Separator />

      <section className="flex flex-col gap-4" aria-label="Comments">
        <h2 className="font-medium">
          {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
        </h2>
        <CommentList comments={post.comments} teamUserIds={teamUserIds} />
        {session ? (
          <CommentForm postId={post.id} />
        ) : (
          <p className="text-sm text-muted-foreground">
            <SignInLink className="text-foreground underline underline-offset-4">
              Sign in
            </SignInLink>{" "}
            to comment.
          </p>
        )}
      </section>
    </div>
  );
}
