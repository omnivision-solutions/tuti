import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { postAudience } from "@tuti/jobs";
import { mediaStorage } from "@tuti/shared/storage";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { CommentSortMenu } from "@/components/comment-actions";
import { commentSort } from "@/lib/comment-threads";
import { StatusLabel, StatusPill } from "@/components/post-status-badge";
import { PortalAvatar } from "@/components/portal-avatar";
import { CopyLinkButton, ShareButton } from "@/components/share-button";
import { SignInLink } from "@/components/sign-in-link";
import { buttonVariants } from "@/components/ui/button";
import { CalendarIcon, LayoutListIcon, MessageCircleIcon, PlusIcon } from "lucide-react";
import { SubscribeButton } from "@/components/subscribe-button";
import { VoterFaces } from "@/components/voter-faces";
import { ItemList, ItemRow } from "@/components/item-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          body: true,
          content: true,
          createdAt: true,
          asReader: true,
          parentId: true,
          author: { select: { id: true, name: true, image: true } },
          _count: { select: { likes: true } },
          likes: { where: { userId: session?.user.id ?? "" }, select: { userId: true } },
        },
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
  const sort = commentSort((await props.searchParams).sort);
  // Images only once signed in: uploads are someone's.
  const uploads = session && mediaStorage() ? { projectSlug, mediaUrls: {} } : undefined;
  const address = `${await portalAddress(projectSlug)}${postPath(post)}`;
  const vote = (shape: "upvote") => (
    <VoteButton shape={shape} postId={post.id} count={post.voteCount} voted={post.votes.length > 0} disabled={!voter} signedOut={!session} />
  );
  const voterFaces = post.voteCount > 0 && (
    // The faces, then how many more (the vote button has the count).
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
  );

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_18.5rem] lg:items-start lg:gap-x-14">
      <div className="flex min-w-0 flex-col gap-6 lg:col-start-1">
        {/* A public post on a Team only board: back to the portal's feedback (its home, when it has no board of its own), not
            to a board only the team may open. */}
        {onTeamBoard ? (
          (await firstBoardPath(projectSlug)) ? (
            <BackLink href={at("/feedback")}>Feedback</BackLink>
          ) : (
            <BackLink href={at("/")}>Home</BackLink>
          )
        ) : (
          <BackLink href={at(boardPath(post.board))} className="font-medium">
            {post.board.name}
          </BackLink>
        )}

        <article className="flex flex-col gap-3">
          <h1 className="font-heading text-[1.75rem] leading-[1.1] font-[650] tracking-[-0.022em] break-words sm:text-[2.375rem]">{post.title}</h1>
          {/* Who asked, then where it stands. */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.9375rem] text-muted-foreground">
            <PortalAvatar person={post.author} className="size-6 text-xs" />
            <span className="font-medium text-foreground/80">{post.author.name}</span>
            <time dateTime={post.createdAt.toISOString()}>{timeAgo(post.createdAt)}</time>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-[0.9375rem]">
            <StatusPill status={post.status} />
            {eta && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <CalendarIcon aria-hidden className="size-4" />
                Expected {formatMonth(eta)}
              </span>
            )}
            {post.sample && <SampleBadge />}
            <VisibilityBadge visibility={post.visibility} />
          </div>
          {!isEmptyDoc(displayDoc(post)) && (
            <RichText
              doc={displayDoc(post)}
              mediaUrls={await mediaUrls(displayDoc(post))}
              className="rich-text mt-3 text-base leading-[1.65] break-words sm:text-[1.0625rem]"
            />
          )}
        </article>
      </div>

      {/* Beside the post on wide screens: one card led by Upvote, then Subscribe, the voters, its details and its link. On phones
          and tablets the actions in a row under the post, the voters under them (the details and the way to a new idea aren't). */}
      <aside
        aria-label="About this idea"
        className="flex flex-wrap items-center gap-x-2 gap-y-4 text-sm lg:sticky lg:top-[calc(var(--portal-header-height,4rem)+1.5rem)] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-12 lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-4 lg:rounded-xl lg:bg-card lg:p-5 lg:shadow-card lg:ring-1 lg:ring-card-edge lg:[&>a]:w-full lg:[&>button]:w-full"
      >
        {vote("upvote")}
        {subscribe}
        {voterFaces && (
          <div className="flex items-center gap-3 max-lg:order-last max-lg:basis-full lg:border-t lg:pt-4">
            {/* On phones the faces are under the actions: named. */}
            <span aria-hidden className="group-label lg:hidden">
              Voters
            </span>
            {voterFaces}
          </div>
        )}
        <dl className="flex flex-col border-t text-[0.9375rem] max-lg:hidden [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-4 [&>div]:py-3 [&>div+div]:border-t">
          {/* A Team only board isn't named to readers (as the way back above doesn't). */}
          {!onTeamBoard && (
            <div>
              <dt className="flex items-center gap-2 text-muted-foreground">
                <LayoutListIcon aria-hidden className="size-4" />
                Board
              </dt>
              <dd className="min-w-0 truncate font-semibold">{post.board.name}</dd>
            </div>
          )}
          <div>
            <dt className="flex items-center gap-2 text-muted-foreground">
              <CalendarIcon aria-hidden className="size-4" />
              Posted
            </dt>
            <dd className="font-semibold">{formatDate(post.createdAt)}</dd>
          </div>
        </dl>
        {shippedIn && <p className="text-muted-foreground max-lg:order-last max-lg:basis-full">Shipped in {shippedIn}</p>}
        <div className="flex flex-wrap items-center gap-1 lg:border-t lg:pt-3 [&>button]:w-auto lg:[&>button:first-child]:-ml-2.5">
          <CopyLinkButton url={address} />
          <ShareButton url={address} title={post.title} />
        </div>
        {!onTeamBoard && (
          <p className="flex items-center gap-2 border-t pt-4 text-[0.9375rem] text-muted-foreground max-lg:hidden">
            <PlusIcon aria-hidden className="size-4" />
            Have another idea?
            <Link href={`${at(boardPath(post.board))}?new`} className="font-medium text-foreground underline decoration-primary/55 decoration-[1.5px] underline-offset-[3px]">
              Post it
            </Link>
          </p>
        )}
      </aside>

      <div className="flex min-w-0 flex-col gap-6 lg:col-start-1">
        {/* Signed out: one bar to sign in (commenting and voting both need it), above the thread. */}
        {!session && (
          <div className="flex flex-col gap-4 rounded-xl bg-card p-5 shadow-card ring-1 ring-card-edge sm:flex-row sm:items-center sm:gap-4 sm:py-4">
            <span aria-hidden className="hidden size-10 shrink-0 place-items-center rounded-lg bg-soft text-soft-foreground sm:grid">
              <MessageCircleIcon className="size-[1.125rem]" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="font-sans text-base font-semibold">Join the conversation</h2>
              <p className="text-[0.9375rem] text-muted-foreground">Sign in to comment and vote.</p>
            </div>
            <SignInLink className={buttonVariants({ size: "lg", className: "font-semibold" })}>Sign in</SignInLink>
          </div>
        )}

        <section className="flex flex-col gap-4 pt-2" aria-label="Comments">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-sans text-lg font-semibold">
              {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
            </h2>
            {post.comments.length > 1 && <CommentSortMenu sort={sort} />}
          </div>
          <CommentList
            portal
            sort={sort}
            ability={{ can: voter ? "act" : session ? "none" : "signIn", postId: post.id, portal: true, uploads }}
            comments={post.comments.map(({ _count, likes, ...comment }) => ({ ...comment, likes: _count.likes, liked: likes.length > 0 }))}
            teamUserIds={teamUserIds}
            events={post.events}
            mediaUrls={await mediaUrls(...post.comments.map(displayDoc))}
          />
          {session && <CommentForm postId={post.id} signedIn uploads={uploads} />}
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
                    badges={
                      <>
                        <VisibilityBadge visibility={like.visibility} />
                        <StatusLabel status={like.status} />
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

    </div>
  );
}
