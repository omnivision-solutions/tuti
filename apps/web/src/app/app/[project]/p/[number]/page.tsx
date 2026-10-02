import { prisma } from "@tuti/db";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { DuplicateSuggestions } from "@/components/duplicate-suggestions";
import { MergePostDialog } from "@/components/merge-post-dialog";
import { MovePostSelect } from "@/components/move-post-select";
import { PostStatusSelect } from "@/components/post-status-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { portalUrl } from "@/lib/hosts";
import { postPath } from "@/lib/post-urls";
import { getMembership } from "@/server/membership";

/** The team's view of a post: reply as the team, change status, move board, merge duplicates. */
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
        duplicateOf: { select: { number: true, title: true } },
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
  const postRef = { id: true, number: true, title: true, voteCount: true } as const;
  const [candidates, suggestions] = post.duplicateOf
    ? [[], []]
    : await Promise.all([
        prisma.post.findMany({
          where: { projectId: project.id, duplicateOfId: null, id: { not: post.id } },
          orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
          take: 500,
          select: postRef,
        }),
        prisma.duplicateSuggestion.findMany({
          where: {
            projectId: project.id,
            status: "PENDING",
            OR: [
              { postId: post.id, original: { duplicateOfId: null } },
              { originalId: post.id, post: { duplicateOfId: null } },
            ],
          },
          orderBy: { similarity: "desc" },
          select: { id: true, similarity: true, post: { select: postRef }, original: { select: postRef } },
        }),
      ]);

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

      {post.duplicateOf ? (
        <Alert>
          <AlertTitle>
            Merged into{" "}
            <Link href={`/app/${slug}/p/${post.duplicateOf.number}`} className="underline underline-offset-4">
              #{post.duplicateOf.number} {post.duplicateOf.title}
            </Link>
          </AlertTitle>
          <AlertDescription>Its votes and comments moved there, and its link points there.</AlertDescription>
        </Alert>
      ) : (
        <Card size="sm">
          <CardContent className="flex flex-wrap items-center gap-4 text-sm">
            <span className="flex items-center gap-2">
              Status <PostStatusSelect projectSlug={slug} postId={post.id} status={post.status} />
            </span>
            <span className="flex items-center gap-2">
              Board <MovePostSelect projectSlug={slug} postId={post.id} boardSlug={post.board.slug} boards={boards} />
            </span>
            <span className="ml-auto">
              <MergePostDialog projectSlug={slug} post={post} candidates={candidates} />
            </span>
          </CardContent>
        </Card>
      )}

      {post.body && <p className="whitespace-pre-wrap break-words">{post.body}</p>}

      {suggestions.length > 0 && (
        <DuplicateSuggestions
          projectSlug={slug}
          postId={post.id}
          suggestions={suggestions.map(({ post: duplicate, ...s }) => ({ ...s, duplicate }))}
        />
      )}

      <section className="flex flex-col gap-4" aria-label="Comments">
        <h2 className="font-medium">
          {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
        </h2>
        <CommentList comments={post.comments} teamUserIds={new Set(team.map((m) => m.userId))} />
        {!post.duplicateOf && <CommentForm postId={post.id} placeholder="Reply as the team…" />}
      </section>
    </>
  );
}
