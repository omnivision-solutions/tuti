import { prisma } from "@tuti/db";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { DuplicateSuggestions } from "@/components/duplicate-suggestions";
import { MergePostDialog } from "@/components/merge-post-dialog";
import { MovePostSelect } from "@/components/move-post-select";
import { PostEtaSelect, PostOwnerSelect } from "@/components/post-planning";
import { PageHeader } from "@/components/page-header";
import { PostLinks } from "@/components/post-links";
import { Property, PostShipped, PostsLike, PostVoters } from "@/components/post-sidebar";
import { PostSteps } from "@/components/post-steps";
import { PostStatusSelect } from "@/components/post-status-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { asking, timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { postPath } from "@/lib/post-urls";
import { getMembership } from "@/server/membership";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { isEmptyDoc } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { displayDoc } from "@/server/content";
import { mediaUrls } from "@/server/media-urls";
import { howShipped, likeFirst, postNeighbours, postsLike, postVoters, votersToEmail, voterTotals } from "@/server/post-lists";

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
        owner: { select: { id: true } },
        duplicateOf: { select: { number: true, title: true } },
        links: {
          orderBy: { createdAt: "asc" },
          select: { id: true, kind: true, repo: true, number: true, tag: true, url: true, title: true, codeChangeId: true },
        },
        events: { orderBy: { createdAt: "asc" }, select: { id: true, from: true, to: true, emailed: true, createdAt: true, actor: { select: { name: true } } } },
        comments: {
          orderBy: { createdAt: "asc" },
          select: { id: true, body: true, content: true, createdAt: true, author: { select: { id: true, name: true, image: true } } },
        },
        notes: {
          orderBy: { createdAt: "asc" },
          select: { id: true, body: true, content: true, createdAt: true, author: { select: { id: true, name: true, image: true } } },
        },
      },
    }),
    prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } }),
    prisma.teamMember.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { userId: true, user: { select: { name: true } } } }),
  ]);
  if (!post) {
    notFound();
  }
  const [totals, voters, shipped, like, neighbours, emails, toEmail] = await Promise.all([
    voterTotals(project.id, project.askingProperty, [post.id]),
    postVoters(project.id, project.askingProperty, post.id),
    howShipped(post.id),
    post.duplicateOf ? [] : postsLike(project.id, post),
    postNeighbours(project.id, post.number),
    emailedOnCompletion(project.id, [post.id]),
    votersToEmail(project.id, post.id),
  ]);
  const total = totals.get(post.id);
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
      <PageHeader
        back={{ href: `/app/${slug}/feedback`, label: "Feedback" }}
        title={post.title}
        meta={
          <>
            #{post.number} · {post.author.name} · {timeAgo(post.createdAt)} · {post.voteCount}{" "}
            {post.voteCount === 1 ? "vote" : "votes"}
            {total !== undefined && ` · ${asking(total, project.askingProperty!)}`}
          </>
        }
        actions={
          <>
            <PostSteps projectSlug={slug} {...neighbours} />
            <a
              href={`${await portalAddress(slug)}${postPath(post)}`}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ExternalLinkIcon />
              View on portal
            </a>
          </>
        }
        more={!post.duplicateOf && <MergePostDialog projectSlug={slug} post={post} candidates={likeFirst(like, candidates)} />}
      />

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
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {!isEmptyDoc(displayDoc(post)) && (
            <RichText doc={displayDoc(post)} mediaUrls={await mediaUrls(displayDoc(post))} className="rich-text break-words" />
          )}

          {!post.duplicateOf && post.links.length > 0 && <PostLinks projectSlug={slug} postId={post.id} links={post.links} />}

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
              {post.notes.length > 0 && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {post.notes.length} internal {post.notes.length === 1 ? "note" : "notes"}
                </span>
              )}
            </h2>
            <CommentList
              comments={[...post.comments, ...post.notes.map((note) => ({ ...note, internal: true }))].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())}
              teamUserIds={new Set(team.map((m) => m.userId))}
              events={post.events.map(({ actor, ...event }) => ({ ...event, by: actor?.name ?? null }))}
            />
            {!post.duplicateOf && <CommentForm postId={post.id} placeholder="Reply as the team…" notes voters={toEmail} />}
          </section>
        </div>

        {/* Its properties, beside it (above it on a phone): held in view as the page scrolls, scrolling on their own when taller than the screen. */}
        {!post.duplicateOf && (
          <aside
            aria-label="Properties"
            className="order-first flex flex-col gap-3 rounded-xl border p-4 text-sm lg:sticky lg:top-18 lg:order-none lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto"
          >
            <Property label="Status">
              <PostStatusSelect
                projectSlug={slug}
                postId={post.id}
                status={post.status}
                completing={{ title: post.title, emails: emails.get(post.id) ?? 0 }}
                className="w-full"
              />
            </Property>
            <Property label="Board">
              <MovePostSelect projectSlug={slug} postId={post.id} boardSlug={post.board.slug} boards={boards} className="w-full max-w-none" />
            </Property>
            <Property label="Owner">
              <PostOwnerSelect projectSlug={slug} postId={post.id} ownerId={post.owner?.id ?? null} team={team.map((m) => ({ id: m.userId, name: m.user.name }))} />
            </Property>
            <Property label="ETA">
              <PostEtaSelect projectSlug={slug} postId={post.id} eta={post.eta?.toISOString().slice(0, 7) ?? null} />
            </Property>
            <Property label="Votes">
              <span>
                {post.voteCount}
                {total !== undefined && <span className="text-muted-foreground"> · {asking(total, project.askingProperty!)}</span>}
              </span>
            </Property>
            <PostVoters voters={voters} voteCount={post.voteCount} property={project.askingProperty} />
            <PostShipped projectSlug={slug} {...shipped} />
            <PostsLike projectSlug={slug} posts={like} />
          </aside>
        )}
      </div>
    </>
  );
}
