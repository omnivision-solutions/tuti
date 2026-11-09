import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { postAudience } from "@tuti/jobs";
import { mediaStorage } from "@tuti/shared/storage";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { VoteButton } from "@/components/vote-button";
import { SampleBadge } from "@/components/sample-badge";
import { etaOnPortal, formatDate, formatMonth, timeAgo } from "@/lib/format";
import { boardPath, postNumberFromParam, postPath } from "@/lib/post-urls";
import { canActIn } from "@/server/membership";
import { currentPostViewer } from "@/server/portal-access";
import { firstBoardPath } from "@/server/portal-home";
import { canSeePost } from "@/server/post-visibility";
import { postsLike } from "@/server/post-lists";
import { getSession } from "@/server/session";
import { isEmptyDoc } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { displayDoc } from "@/server/content";
import { portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";
import { VisibilityBadge } from "@/components/visibility-badge";
import { CopyButton } from "@/components/copy-button";
import { portalAddress } from "@/server/custom-domains";

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
      board: { select: { slug: true, name: true, postVisibility: true, off: true } },
      author: { select: { id: true, name: true, image: true } },
      votes: { where: { userId: session?.user.id ?? "" }, select: { userId: true } },
      subscriptions: { where: { userId: session?.user.id ?? "" }, select: { userId: true } },
      // Told it shipped already (a completion before it was reopened): never emailed about it again.
      shippedEmails: { where: { userId: session?.user.id ?? "", sentAt: { not: null } }, select: { userId: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, body: true, content: true, createdAt: true, asReader: true, author: { select: { id: true, name: true, image: true } } },
      },
      // Its status history: from what to what, and when; not who changed it or how many were emailed.
      events: { orderBy: { createdAt: "asc" }, select: { id: true, from: true, to: true, createdAt: true } },
      project: { select: { portalAccess: true, plan: true, team: { select: { userId: true } } } },
      duplicateOf: { select: { number: true, title: true, visibility: true, authorId: true, board: { select: { slug: true, off: true } } } },
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
  // A post they may not see (post-visibility.ts), with its comments and votes, is as good as missing; so is one merged
  // into a post they may not see.
  const viewer = await currentPostViewer(post.projectId);
  if (!canSeePost(viewer, post) || (post.duplicateOf && !canSeePost(viewer, post.duplicateOf))) {
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
  // voting, only for those who may act here (others get "sign in", as the vote button says). Never on a sample post
  // (server/sample-content.ts): it emails nobody, and its Sample badge says what it is.
  const subscribable = !post.sample && post.status !== "COMPLETED" && post.status !== "CLOSED" && post.shippedEmails.length === 0;
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
    postsLike(post.projectId, post, viewer, { open: true }),
    voter && subscribable ? postAudience(post.projectId, post.project, post, [voter]) : [],
  ]);

  // The month the team expects it, as their ETA says it, while it's still to come.
  const eta = post.eta && etaOnPortal(post.eta, post.status) ? post.eta : null;

  // A public post on a Team only board, read by someone not on the team: the board stays unnamed.
  const onTeamBoard = post.board.postVisibility === "TEAM" && !viewer.team;
  const subscribe = subscribable && (!voter || hears.length > 0) && (
    <SubscribeButton postId={post.id} subscribed={post.subscriptions.length > 0} following={following} signedIn={!!voter} />
  );
  const shippedIn = post.changelogEntries[0] && (
    <Link href={at(`/changelog/${post.changelogEntries[0].entry.number}`)} className="font-medium text-foreground hover:underline">
      {post.changelogEntries[0].entry.title}
    </Link>
  );

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start lg:gap-x-10">
      {/* A public post on a Team only board: back to the portal's feedback (its home, when it has no board of its own), not
          to a board only the team may open. */}
      {onTeamBoard ? (
        (await firstBoardPath(projectSlug)) ? (
          <BackLink href={at("/feedback")}>Feedback</BackLink>
        ) : (
          <BackLink href={at("/")}>Home</BackLink>
        )
      ) : (
        <BackLink href={at(boardPath(post.board))}>{post.board.name}</BackLink>
      )}

      <article className="flex flex-col gap-4 lg:col-start-1">
        <h1 className="font-heading text-[1.75rem] leading-tight font-semibold tracking-tight break-words sm:text-[2rem]">{post.title}</h1>
        {/* Where it stands first, then who asked. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <PostStatusBadge status={post.status} />
            {eta && <span className="font-medium">Expected {formatMonth(eta)}</span>}
            {post.sample && <SampleBadge />}
            <VisibilityBadge visibility={post.visibility} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Avatar size="sm" aria-hidden>
              {post.author.image && <AvatarImage src={post.author.image} alt="" />}
              <AvatarFallback>{post.author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="font-medium text-foreground">{post.author.name}</span>
            <span aria-hidden>·</span>
            <time dateTime={post.createdAt.toISOString()}>{timeAgo(post.createdAt)}</time>
          </div>
        </div>
        {!isEmptyDoc(displayDoc(post)) && (
          <RichText doc={displayDoc(post)} mediaUrls={await mediaUrls(displayDoc(post))} className="rich-text text-base break-words" />
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <VoteButton pill postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!voter} signedOut={!session} />
          {post.voteCount > 0 && (
            // The faces, then how many more (the pill beside them has the count).
            <VoterFaces
              voters={voters.map((vote) => vote.user)}
              count={post.voteCount}
              // Short beside the faces; the whole sentence for screen readers (the faces are hidden from them).
              label={
                <>
                  <span aria-hidden>
                    {post.voteCount > voters.length ? `+${post.voteCount - voters.length} more` : `${post.voteCount === 1 ? "wants" : "want"} this`}
                  </span>
                  <span className="sr-only">
                    {post.voteCount} {post.voteCount === 1 ? "person wants this" : "people want this"}
                  </span>
                </>
              }
            />
          )}
        </div>
      </article>

      {/* Beside the post on wide screens: following it, and what isn't said beside the title. Below them, only Subscribe, under the post. */}
      <aside
        aria-label="About this idea"
        className="flex flex-wrap items-center gap-3 lg:col-start-2 lg:row-span-4 lg:row-start-2 lg:flex-col lg:flex-nowrap lg:items-stretch lg:[&>a]:w-full lg:[&>button]:w-full"
      >
        {subscribe}
        <CopyButton value={`${await portalAddress(projectSlug)}${postPath(post)}`} label="link" wide />
        <dl className="grid max-lg:hidden grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3 rounded-xl bg-card p-4 text-sm shadow-xs ring-1 ring-border">
          {/* A Team only board isn't named to readers (as the way back above doesn't). */}
          {!onTeamBoard && (
            <>
              <dt className="text-muted-foreground">Board</dt>
              <dd className="justify-self-end truncate font-medium">{post.board.name}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Posted</dt>
          <dd className="justify-self-end font-medium">{formatDate(post.createdAt)}</dd>
        </dl>
        {shippedIn && <p className="text-sm text-muted-foreground max-lg:basis-full">Shipped in {shippedIn}</p>}
      </aside>

      <section className="flex flex-col gap-4 border-t pt-6 lg:col-start-1" aria-label="Comments">
        <h2 className="text-base font-semibold">
          {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
        </h2>
        <CommentList comments={post.comments} teamUserIds={teamUserIds} events={post.events} mediaUrls={await mediaUrls(...post.comments.map(displayDoc))} />
        {/* Images only once signed in: uploads are someone's. */}
        <CommentForm postId={post.id} signedIn={!!session} uploads={session && mediaStorage() ? { projectSlug, mediaUrls: {} } : undefined} />
      </section>

      {similar.length > 0 && (
        <Card role="region" aria-labelledby="similar-ideas" className="lg:col-start-1">
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
                  badges={
                    <>
                      <VisibilityBadge visibility={like.visibility} />
                      <PostStatusBadge status={like.status} />
                    </>
                  }
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
