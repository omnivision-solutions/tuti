import { type PostVisibility, prisma } from "@tuti/db";
import { mediaStorage } from "@tuti/shared/storage";
import { historySince, seenAs, visibleConversations } from "@tuti/jobs";
import { CalendarIcon, ChevronUpIcon, CircleDotIcon, ExternalLinkIcon, EyeIcon, LayoutListIcon, UserRoundIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { CommentSortMenu } from "@/components/comment-actions";
import { commentSort } from "@/lib/comment-threads";
import { DuplicateSuggestions } from "@/components/duplicate-suggestions";
import { MergePostDialog } from "@/components/merge-post-dialog";
import type { PickablePost } from "@/components/post-picker";
import { MovePostSelect } from "@/components/move-post-select";
import { PhoneFold, PostEtaSelect, PostOwnerSelect, PostVisibilitySelect } from "@/components/post-planning";
import { VisibilityBadge } from "@/components/visibility-badge";
import { feedbackMenu } from "@/components/feedback-menu";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { PostLinks } from "@/components/post-links";
import { CONVERSATIONS_SHOWN, Property, PropertyRow, PostConversations, QUIET_TRIGGER, PostShipped, PostsLike, PostVoters } from "@/components/post-sidebar";
import { PostSteps } from "@/components/post-steps";
import { PostStatusSelect } from "@/components/post-status-select";
import { PostStatusBadge } from "@/components/post-status-badge";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { SampleBadge } from "@/components/sample-badge";
import { formatMonth, timeAgo } from "@/lib/format";
import { storedPropertyFormats } from "@/lib/property-formats";
import { portalAddress } from "@/server/custom-domains";
import { postPath } from "@/lib/post-urls";
import { getMembership } from "@/server/membership";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { conversationPerson } from "@/server/operations/conversations";
import { isEmptyDoc } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { displayDoc } from "@/server/content";
import { mediaUrls } from "@/server/media-urls";
import { TEAM_VIEWER } from "@/server/post-visibility";
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
  const formats = storedPropertyFormats(project.propertyFormats);

  const linked = { spam: false, AND: [visibleConversations(await historySince(project.id))] };
  const [post, boards, team] = await Promise.all([
    prisma.post.findUnique({
      where: { projectId_number: { projectId: project.id, number } },
      include: {
        board: { select: { slug: true, off: true } },
        author: { select: { name: true } },
        owner: { select: { id: true } },
        duplicateOf: { select: { number: true, title: true } },
        duplicates: { orderBy: { createdAt: "asc" }, select: { number: true, title: true } },
        links: {
          orderBy: { createdAt: "asc" },
          select: { id: true, kind: true, repo: true, number: true, tag: true, url: true, title: true, codeChangeId: true },
        },
        // The latest linked, and how many there are (not those past the plan's history).
        _count: { select: { conversations: { where: { conversation: linked } } } },
        conversations: {
          where: { conversation: linked },
          orderBy: { createdAt: "desc" },
          take: CONVERSATIONS_SHOWN,
          select: {
            conversation: {
              select: {
                number: true,
                subject: true,
                status: true,
                email: true,
                name: true,
                emailVerified: true,
                user: { select: { name: true, email: true, ssoIdentity: { select: { externalId: true, email: true } } } },
              },
            },
          },
        },
        events: { orderBy: { createdAt: "asc" }, select: { id: true, from: true, to: true, emailed: true, createdAt: true, actor: { select: { name: true } } } },
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
            likes: { where: { userId: membership.userId }, select: { userId: true } },
          },
        },
        notes: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
  const [totals, voters, shipped, like, neighbours, emails, toEmail, menu] = await Promise.all([
    voterTotals(project.id, project.askingProperty, [post.id]),
    postVoters(project.id, project.askingProperty, post.id),
    howShipped(post.id),
    post.duplicateOf ? [] : postsLike(project.id, post, TEAM_VIEWER),
    postNeighbours(project.id, post.number),
    emailedOnCompletion(project.id, [post.id]),
    // Only for the reply form, which a merged post doesn't have.
    post.duplicateOf ? 0 : votersToEmail(project.id, post.id),
    // Feedback's menu, its queries alongside the post's.
    // Only where it leaves the post's pane room for its two columns (48rem of it, with its padding).
    feedbackMenu({ project, role: membership.role, className: "@max-[76rem]/app:hidden!" }),
  ]);
  const total = totals.get(post.id);
  const sort = commentSort((await props.searchParams).sort);
  const uploads = mediaStorage() ? { projectSlug: slug, mediaUrls: {} } : undefined;
  const postRef = { id: true, number: true, title: true, voteCount: true, sample: true, visibility: true, authorId: true, board: { select: { off: true } } } as const;
  // Who sees each, as merging warns of it: a post on a board turned off is the team's only (seenAs).
  const seen = <T extends { visibility: PostVisibility; board: { off: boolean } }>(row: T) => ({ ...row, visibility: seenAs(row) });
  const [candidateRows, suggestionRows] = post.duplicateOf
    ? [[], []]
    : await Promise.all([
        prisma.post.findMany({
          // Sample posts merge with sample ones only, the team's with theirs (mergePosts refuses the rest).
          where: { projectId: project.id, duplicateOfId: null, id: { not: post.id }, sample: post.sample },
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
  const candidates = candidateRows.map(seen);
  const suggestions = suggestionRows.map((s) => ({ ...s, post: seen(s.post), original: seen(s.original) }));

  return (
    <PaneLayout>
      {menu}
      <Pane aria-label="Post">
        <PaneHeader
          back={{ href: `/app/${slug}/feedback?status=all`, label: "All posts" }}
          title={post.title}
          // The newer and older post, the portal and Merge; round icons on phones but Merge.
          actions={
            <>
              <PostSteps projectSlug={slug} {...neighbours} />
              <a
                href={`${await portalAddress(slug)}${postPath(post)}`}
                target="_blank"
                rel="noreferrer"
                title="View on portal"
                className={buttonVariants({ variant: "outline", size: "sm", className: "@max-[48rem]/app:size-8 @max-[48rem]/app:px-0" })}
              >
                <ExternalLinkIcon />
                <span className="@max-[48rem]/app:sr-only">View on portal</span>
              </a>
              {!post.duplicateOf && <MergePostDialog projectSlug={slug} post={seen(post)} candidates={likeFirst<PickablePost>(like, candidates)} />}
            </>
          }
        />
        <PaneBody className="@container/post p-4 @min-[48rem]/app:px-8 @min-[48rem]/app:py-7">
      {/* The post (its title, then it) beside its properties, both from the top. In a narrow pane one column: the
          title, the properties, the post, the rest of the sidebar (each placed by its order, the columns' boxes dropped). */}
      <div className="grid gap-6 @min-[48rem]/post:grid-cols-[minmax(0,48rem)_18rem] @min-[48rem]/post:grid-rows-[auto_1fr] @min-[48rem]/post:items-start @min-[48rem]/post:justify-center @min-[48rem]/post:gap-10">
        <div data-slot="post-header" className="flex min-w-0 flex-col gap-4 @min-[48rem]/post:col-start-1 @min-[48rem]/post:row-start-1">
          <div className="flex min-w-0 flex-col gap-1.5">
            {/* The title large, over the post: the pane header's heading says it to screen readers. */}
            <p aria-hidden className="font-heading text-2xl font-semibold tracking-[-0.02em] text-balance break-words @min-[48rem]/app:text-[1.75rem]">
              {post.title}
            </p>
            <p className="text-sm text-muted-foreground">
              {/* Its status is in its properties, beside it. */}
              {post.sample && <SampleBadge />} <VisibilityBadge visibility={seenAs(post)} /> #{post.number} · {post.author.name} · {timeAgo(post.createdAt)}
              {/* A merged post's votes moved with it. */}
              {!post.duplicateOf && (
                <>
                  {" · "}
                  <span className="font-medium text-foreground tabular-nums">
                    ▲ {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
                  </span>
                </>
              )}
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
          ) : null}
        </div>
        {/* In the page's order on phones (the header, the properties, the post), so the keyboard and screen readers
            meet them in the order they're seen; beside the post from laptop width up, from the top. */}
        {/* Its properties, beside it (after it, narrower than a laptop): held in view as the page scrolls, scrolling on their own when taller than the screen. */}
        {!post.duplicateOf && (
          // Beside the post, held in view as it scrolls. On phones its parts go apart: the properties above the post
          // (what triage changes, in reach), the rest (voters, what shipped it, …) after its comments.
          <aside
            aria-label="Properties"
            className="text-sm @min-[48rem]/post:sticky @min-[48rem]/post:top-0 @min-[48rem]/post:col-start-2 @min-[48rem]/post:row-span-2 @min-[48rem]/post:row-start-1 @min-[48rem]/post:flex @min-[48rem]/post:flex-col @min-[48rem]/post:gap-6 @min-[48rem]/post:max-h-[calc(100dvh-9rem)] @min-[48rem]/post:overflow-y-auto @min-[48rem]/post:border-l @min-[48rem]/post:pl-6"
          >
            {/* A card on phones, folded to a line (status, owner, ETA); beside the post, open rows under a heading. */}
            <div className="flex flex-col rounded-xl bg-card px-4 py-3 shadow-xs ring-1 ring-border @min-[48rem]/post:rounded-none @min-[48rem]/post:bg-transparent @min-[48rem]/post:p-0 @min-[48rem]/post:shadow-none @min-[48rem]/post:ring-0">
              <h2 className="group-label mb-1 @min-[48rem]/post:mb-2">Properties</h2>
              <PhoneFold
                summary={
                  <>
                    <span className="sr-only">Properties: </span>
                    <PostStatusBadge status={post.status} />
                    <span className="min-w-0 truncate text-muted-foreground">
                      {post.owner ? team.find((m) => m.userId === post.owner!.id)?.user.name : "No owner"}
                      {post.eta && ` · ${formatMonth(post.eta)}`}
                    </span>
                  </>
                }
              >
              <PropertyRow icon={CircleDotIcon} label="Status">
                <PostStatusSelect
                  projectSlug={slug}
                  postId={post.id}
                  status={post.status}
                  completing={{ title: post.title, emails: emails.get(post.id) ?? 0 }}
                  className={QUIET_TRIGGER}
                />
              </PropertyRow>
              <PropertyRow icon={LayoutListIcon} label="Board">
                <MovePostSelect projectSlug={slug} postId={post.id} boardSlug={post.board.slug} boards={boards} className={cn(QUIET_TRIGGER, "max-w-none")} />
              </PropertyRow>
              <PropertyRow icon={EyeIcon} label="Visibility">
                <PostVisibilitySelect projectSlug={slug} postId={post.id} visibility={post.visibility} boardOff={post.board.off} className={QUIET_TRIGGER} quietHint />
              </PropertyRow>
              <PropertyRow icon={UserRoundIcon} label="Owner">
                <PostOwnerSelect projectSlug={slug} postId={post.id} ownerId={post.owner?.id ?? null} team={team.map((m) => ({ id: m.userId, name: m.user.name }))} className={QUIET_TRIGGER} />
              </PropertyRow>
              <PropertyRow icon={CalendarIcon} label="ETA">
                <PostEtaSelect projectSlug={slug} postId={post.id} eta={post.eta?.toISOString().slice(0, 7) ?? null} status={post.status} className={QUIET_TRIGGER} />
              </PropertyRow>
              {/* Its votes in Voters' heading below; here only when nobody's voted (there's no Voters then). */}
              {voters.length === 0 && (
                <PropertyRow icon={ChevronUpIcon} label="Votes">
                  <span className="flex h-8 items-center tabular-nums">{post.voteCount}</span>
                </PropertyRow>
              )}
              </PhoneFold>
            </div>
            <div className="flex flex-col gap-6 empty:hidden @max-[48rem]/post:hidden @min-[48rem]/post:border-t @min-[48rem]/post:pt-5">
            <PostVoters voters={voters} voteCount={post.voteCount} property={project.askingProperty} formats={formats} total={total} />
            <PostConversations
              projectSlug={slug}
              count={post._count.conversations}
              conversations={post.conversations.map(({ conversation }) => {
                const person = conversationPerson(conversation);
                return { ...conversation, person: person.name ?? person.email ?? "Unknown" };
              })}
            />
            {post.duplicates.length > 0 && (
              <Property label="Merged into it">
                <ul aria-label="Merged posts" className="flex flex-col gap-1">
                  {post.duplicates.map((duplicate) => (
                    <li key={duplicate.number}>
                      <Link href={`/app/${slug}/p/${duplicate.number}`} className="break-words hover:underline">
                        #{duplicate.number} {duplicate.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Property>
            )}
            {/* The pull request that shipped it is in its links already (a chip over the comments) when it's linked. */}
            <PostShipped projectSlug={slug} {...shipped} change={shipped.change && !post.links.some((link) => link.codeChangeId === shipped.change!.id) ? shipped.change : null} />
            <PostsLike projectSlug={slug} posts={like} />
            </div>
          </aside>
        )}
          <div className="flex min-w-0 flex-col gap-6 @min-[48rem]/post:col-start-1 @min-[48rem]/post:row-start-2">
          {isEmptyDoc(displayDoc(post)) ? (
            <p className="text-sm text-muted-foreground italic">No description.</p>
          ) : (
            <RichText doc={displayDoc(post)} mediaUrls={await mediaUrls(displayDoc(post))} className="rich-text max-w-[65ch] break-words" />
          )}

          {!post.duplicateOf && post.links.length > 0 && <PostLinks projectSlug={slug} postId={post.id} links={post.links} />}

          {suggestions.length > 0 && (
            <DuplicateSuggestions
              projectSlug={slug}
              postId={post.id}
              suggestions={suggestions.map(({ post: duplicate, ...s }) => ({ ...s, duplicate }))}
            />
          )}

          {/* A merged post's comments and notes moved with it; its status history stays. */}
          {(!post.duplicateOf || post.events.length > 0) && (
            <section className="flex flex-col gap-4" aria-label={post.duplicateOf ? "Status history" : "Comments"}>
              {!post.duplicateOf && (
                <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">
                  {post.comments.length === 0 ? (
                    <span className="font-normal text-muted-foreground">No comments yet. Reply to tell its voters what&apos;s next.</span>
                  ) : (
                    `${post.comments.length} ${post.comments.length === 1 ? "comment" : "comments"}`
                  )}
                  {post.notes.length > 0 && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {post.notes.length} internal {post.notes.length === 1 ? "note" : "notes"}
                    </span>
                  )}
                </h2>
                {post.comments.length + post.notes.length > 1 && <CommentSortMenu sort={sort} />}
                </div>
              )}
              <CommentList
                sort={sort}
                ability={post.duplicateOf ? undefined : { can: "act", postId: post.id, uploads }}
                comments={[...post.comments.map(({ _count, likes, ...comment }) => ({ ...comment, likes: _count.likes, liked: likes.length > 0 })), ...post.notes.map((note) => ({ ...note, internal: true }))].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())}
                teamUserIds={new Set(team.map((m) => m.userId))}
                events={post.events.map(({ actor, ...event }) => ({ ...event, by: actor?.name ?? null }))}
                mediaUrls={await mediaUrls(...post.comments.map(displayDoc), ...post.notes.map(displayDoc))}
              />
              {!post.duplicateOf && <CommentForm
                  postId={post.id}
                  placeholder="Reply as the team…"
                  notes
                  voters={toEmail}
                  uploads={uploads}
                />}
            </section>
          )}
          </div>
          {/* On phones the rest of the sidebar (voters, what shipped it, …) after the post, here in the page's order
              too (beside it, from laptop width up, it's the aside's). */}
          {!post.duplicateOf && (
            <div className="flex flex-col gap-6 text-sm empty:hidden @min-[48rem]/post:hidden">
              <PostVoters voters={voters} voteCount={post.voteCount} property={project.askingProperty} formats={formats} total={total} />
              <PostConversations
                projectSlug={slug}
                count={post._count.conversations}
                conversations={post.conversations.map(({ conversation }) => {
                  const person = conversationPerson(conversation);
                  return { ...conversation, person: person.name ?? person.email ?? "Unknown" };
                })}
              />
              {post.duplicates.length > 0 && (
                <Property label="Merged into it">
                  <ul aria-label="Merged posts" className="flex flex-col gap-1">
                    {post.duplicates.map((duplicate) => (
                      <li key={duplicate.number}>
                        <Link href={`/app/${slug}/p/${duplicate.number}`} className="break-words hover:underline">
                          #{duplicate.number} {duplicate.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Property>
              )}
              {/* The pull request that shipped it is in its links already (a chip over the comments) when it's linked. */}
              <PostShipped projectSlug={slug} {...shipped} change={shipped.change && !post.links.some((link) => link.codeChangeId === shipped.change!.id) ? shipped.change : null} />
              <PostsLike projectSlug={slug} posts={like} />
            </div>
          )}
      </div>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
