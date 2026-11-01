import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { postAudience } from "@tuti/jobs";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { PostStatusBadge } from "@/components/post-status-badge";
import { SubscribeButton } from "@/components/subscribe-button";
import { VoterFaces } from "@/components/voter-faces";
import { ItemList, ItemRow } from "@/components/item-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { VoteButton } from "@/components/vote-button";
import { SampleBadge } from "@/components/sample-badge";
import { timeAgo } from "@/lib/format";
import { boardPath, postNumberFromParam, postPath } from "@/lib/post-urls";
import { canActIn } from "@/server/membership";
import { postsLike } from "@/server/post-lists";
import { getSession } from "@/server/session";
import { isEmptyDoc } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { displayDoc } from "@/server/content";
import { portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";

/** Sample content (server/sample-content.ts) is kept from search engines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/feedback/[board]/[post]">): Promise<Metadata> {
  const { project, post } = await props.params;
  const number = postNumberFromParam(post);
  const sample = number !== null && (await prisma.post.count({ where: { project: { slug: project }, number, sample: true } })) > 0;
  return sample ? { robots: { index: false } } : {};
}

export default async function PortalPostPage(props: PageProps<"/portal/[project]/feedback/[board]/[post]">) {
  const at = await portalLinks();
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
      subscriptions: { where: { userId: session?.user.id ?? "" }, select: { userId: true } },
      // Told it shipped already (a completion before it was reopened): never emailed about it again.
      shippedEmails: { where: { userId: session?.user.id ?? "", sentAt: { not: null } }, select: { userId: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, content: true, createdAt: true, author: { select: { id: true, name: true, image: true } } },
      },
      // Its status history: from what to what, and when; not who changed it or how many were emailed.
      events: { orderBy: { createdAt: "asc" }, select: { id: true, from: true, to: true, createdAt: true } },
      project: { select: { portalAccess: true, plan: true, team: { select: { userId: true } } } },
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
    permanentRedirect(at(postPath(post.duplicateOf)));
  }
  // Retitled or moved to another board since the link was made: send to the current URL.
  if (`/feedback/${boardParam}/${param}` !== postPath(post)) {
    permanentRedirect(at(postPath(post)));
  }
  const teamUserIds = new Set(post.project.team.map((m) => m.userId));
  // As voting checks it: someone signed in through another project's single sign-on can't vote here.
  const voter = session && (await canActIn(session.user.id, post.projectId)) ? session.user.id : null;
  // Subscribe, while it may still ship, for people its shipped email can reach (postShipped's postAudience) and hasn't
  // already (it never emails anyone twice about a post, completed again or not); as
  // voting, only for those who may act here (others get "sign in", as the vote button says).
  const subscribable = post.status !== "COMPLETED" && post.status !== "CLOSED" && post.shippedEmails.length === 0;
  // Its shipped email goes to them anyway: they posted, voted or commented.
  const following =
    post.votes.length > 0 || post.author.id === session?.user.id || post.comments.some((comment) => comment.author.id === session?.user.id);
  const [voters, similar, hears] = await Promise.all([
    // A few of its voters' faces (no names: a vote isn't signed), the latest first.
    prisma.vote.findMany({
      where: { postId: post.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { user: { select: { id: true, name: true, image: true } } },
    }),
    postsLike(post.projectId, post, { open: true }),
    voter && subscribable ? postAudience(post.projectId, post.project, [voter]) : [],
  ]);

  return (
    <div className="flex flex-col gap-6">
      <BackLink href={at(boardPath(post.board))}>{post.board.name}</BackLink>

      <article className="flex items-start gap-4">
        <VoteButton postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!voter} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight break-words">{post.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <PostStatusBadge status={post.status} />
            {post.sample && <SampleBadge />}
            <span>{post.author.name}</span>
            <span>·</span>
            <time dateTime={post.createdAt.toISOString()}>{timeAgo(post.createdAt)}</time>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {post.voteCount > 0 && <VoterFaces voters={voters.map((vote) => vote.user)} count={post.voteCount} />}
            {subscribable && (!voter || hears.length > 0) && (
              <SubscribeButton postId={post.id} subscribed={post.subscriptions.length > 0} following={following} signedIn={!!voter} />
            )}
          </div>
          {post.changelogEntries[0] && (
            <p className="text-sm text-muted-foreground">
              Shipped in{" "}
              <Link href={at(`/changelog/${post.changelogEntries[0].entry.number}`)} className="text-foreground hover:underline">
                {post.changelogEntries[0].entry.title}
              </Link>
            </p>
          )}
          {!isEmptyDoc(displayDoc(post)) && (
            <RichText doc={displayDoc(post)} mediaUrls={await mediaUrls(displayDoc(post))} className="rich-text break-words" />
          )}
        </div>
      </article>

      <Separator />

      <section className="flex flex-col gap-4" aria-label="Comments">
        <h2 className="font-medium">
          {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
        </h2>
        <CommentList comments={post.comments} teamUserIds={teamUserIds} events={post.events} />
        <CommentForm postId={post.id} signedIn={!!session} />
      </section>

      {similar.length > 0 && (
        <Card role="region" aria-labelledby="similar-ideas">
          <CardHeader>
            <CardTitle>
              <h2 id="similar-ideas">Similar ideas</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ItemList>
              {similar.map((like) => (
                <ItemRow
                  key={like.id}
                  title={
                    <Link href={at(postPath({ ...like, board: { slug: like.boardSlug } }))} className="hover:underline">
                      {like.title}
                    </Link>
                  }
                  badges={<PostStatusBadge status={like.status} />}
                  meta={`${like.voteCount} ${like.voteCount === 1 ? "vote" : "votes"}`}
                />
              ))}
            </ItemList>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
