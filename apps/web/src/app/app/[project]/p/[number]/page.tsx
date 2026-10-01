import { prisma } from "@tuti/db";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { MovePostSelect } from "@/components/move-post-select";
import { PostStatusSelect } from "@/components/post-status-select";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { portalUrl } from "@/lib/hosts";
import { postPath } from "@/lib/post-urls";
import { getMembership } from "@/server/membership";

/** The team's view of a post: reply as the team, change status, move board. */
export default async function TeamPostPage(props: PageProps<"/app/[project]/p/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  const membership = await getMembership(slug);
  if (!membership || !Number.isInteger(number) || number < 1) {
    notFound();
  }
  const { project } = membership;

  const [post, boards, team] = await Promise.all([
    prisma.post.findUnique({
      where: { projectId_number: { projectId: project.id, number } },
      include: {
        board: { select: { slug: true } },
        author: { select: { name: true } },
        comments: {
          orderBy: { createdAt: "asc" },
          select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true, image: true } } },
        },
      },
    }),
    prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } }),
    prisma.teamMember.findMany({ where: { projectId: project.id }, select: { userId: true } }),
  ]);
  if (!post) {
    notFound();
  }

  return (
    <>
      <Link
        href={`/app/${slug}`}
        className={buttonVariants({ variant: "link", size: "sm", className: "self-start px-0 text-muted-foreground" })}
      >
        <ArrowLeftIcon />
        Feedback
      </Link>

      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{post.title}</h1>
          <a
            href={`${portalUrl(slug)}${postPath(post)}`}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ExternalLinkIcon />
            View on portal
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          #{post.number} · {post.author.name} · {timeAgo(post.createdAt)} · {post.voteCount}{" "}
          {post.voteCount === 1 ? "vote" : "votes"}
        </p>
      </div>

      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            Status <PostStatusSelect projectSlug={slug} postId={post.id} status={post.status} />
          </span>
          <span className="flex items-center gap-2">
            Board <MovePostSelect projectSlug={slug} postId={post.id} boardSlug={post.board.slug} boards={boards} />
          </span>
        </CardContent>
      </Card>

      {post.body && <p className="whitespace-pre-wrap break-words">{post.body}</p>}

      <section className="flex flex-col gap-4" aria-label="Comments">
        <h2 className="font-medium">
          {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
        </h2>
        <CommentList comments={post.comments} teamUserIds={new Set(team.map((m) => m.userId))} />
        <CommentForm postId={post.id} placeholder="Reply as the team…" />
      </section>
    </>
  );
}
