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
import { PostStatusSelect } from "@/components/post-status-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { asking, timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";
import { postPath } from "@/lib/post-urls";
import { getMembership } from "@/server/membership";
import { isEmptyDoc } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { displayDoc } from "@/server/content";
import { mediaUrls } from "@/server/media-urls";
import { howShipped, postVoters, VOTERS_SHOWN, voterTotals } from "@/server/post-lists";

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
  const [totals, voters, shipped] = await Promise.all([
    voterTotals(project.id, project.askingProperty, [post.id]),
    postVoters(project.id, project.askingProperty, post.id),
    howShipped(post.id),
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
          <a
            href={`${await portalAddress(slug)}${postPath(post)}`}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ExternalLinkIcon />
            View on portal
          </a>
        }
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
            {!post.duplicateOf && <CommentForm postId={post.id} placeholder="Reply as the team…" notes />}
          </section>
        </div>

        {/* Its properties, beside it (above it on a phone). */}
        {!post.duplicateOf && (
          <aside aria-label="Properties" className="order-first flex flex-col gap-3 rounded-xl border p-4 text-sm lg:order-none lg:sticky lg:top-18">
            <Property label="Status">
              <PostStatusSelect projectSlug={slug} postId={post.id} status={post.status} className="w-full" />
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
            {voters.length > 0 && (
              <Property label="Voters">
                <ul aria-label="Voters" className="flex flex-col gap-1">
                  {voters.map((voter) => (
                    <li key={voter.userId} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 break-words">
                        {voter.name}
                        {voter.company && <span className="text-muted-foreground"> · {voter.company}</span>}
                      </span>
                      {voter.value !== null && <span className="shrink-0 text-muted-foreground tabular-nums">{asking(voter.value, project.askingProperty!)}</span>}
                    </li>
                  ))}
                </ul>
                {post.voteCount > VOTERS_SHOWN && <span className="text-xs text-muted-foreground">{post.voteCount - voters.length} more</span>}
              </Property>
            )}
            {shipped.change && (
              <Property label="Shipped by">
                <Link href={`/app/${slug}/autopilot/${shipped.change.id}`} className="hover:underline">
                  {shipped.change.repo}#{shipped.change.number}
                </Link>
              </Property>
            )}
            {shipped.entries.length > 0 && (
              <Property label="Changelog">
                {shipped.entries.map((entry) => (
                  <Link key={entry.number} href={`/app/${slug}/changelog/${entry.number}`} className="hover:underline">
                    {entry.title}
                    <span className="text-muted-foreground"> · {entry.publishedAt ? "Published" : "Draft"}</span>
                  </Link>
                ))}
              </Property>
            )}
            <MergePostDialog projectSlug={slug} post={post} candidates={candidates} />
          </aside>
        )}
      </div>
    </>
  );
}

/** One of the post's properties in its sidebar: a label above its control. */
function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
