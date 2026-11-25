import type { Metadata } from "next";
import { createHash } from "node:crypto";

import type { Doc } from "@tuti/content";
import { imageKey, imageWidths } from "@tuti/content/media";
import { ImportSource, prisma } from "@tuti/db";
import { aiPaused, autopilotLines, onlyPullRequestTitles, projectEmailWaits, RUNNING_DRAFT_TITLE, subscriberCount, subscribersLeft } from "@tuti/jobs";
import { markersIn } from "@/server/release-notes";
import { aiEnabled } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";
import { cn } from "cn";
import { ExternalLinkIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { ChangelogEntryActions, ChangelogForm, ChangelogSaving, type TagName } from "@/components/changelog";
import { ChangelogComment } from "@/components/changelog-comment";
import { CommentList } from "@/components/comments";
import { PageActions } from "@/components/page-actions";
import { buttonVariants } from "@/components/ui/button";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { SampleBadge } from "@/components/sample-badge";
import { COMMENTS_HEADING } from "@/lib/comment-threads";
import { formatDate } from "@/lib/format";
import { entryPosts, entryTold } from "@/server/changelog-queries";
import { IMPORT_SOURCES, type ImportSourceKey } from "@/lib/import-parts";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { displayDoc } from "@/server/content";
import { automaticDesign, coverContent, coverDesigns } from "@/server/cover-card";
import { portalAddress } from "@/server/custom-domains";
import { getMembership } from "@/server/membership";
import { lastingImage, lastingMediaUrl, mediaUrls } from "@/server/media-urls";
import { pageTitle } from "@/lib/page-title";
import { claimsOf, groupClaims } from "@/lib/reader-groups";

/** The tab: the entry's title. */
export async function generateMetadata(props: PageProps<"/app/[project]/changelog/[number]">): Promise<Metadata> {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  const membership = await getMembership(slug);
  const entry =
    membership && Number.isInteger(number) && number > 0
      ? await prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId: membership.project.id, number } }, select: { title: true } })
      : null;
  return { title: entry?.title ? `${pageTitle(entry.title)} · Changelog` : "Changelog" };
}

export default async function ChangelogEntryPage(props: PageProps<"/app/[project]/changelog/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  const membership = await getMembership(slug);
  if (!membership || !Number.isInteger(number) || number < 1) {
    notFound();
  }
  const entry = await prisma.changelogEntry.findUnique({
    where: { projectId_number: { projectId: membership.project.id, number } },
    select: {
      id: true,
      number: true,
      title: true,
      body: true,
      content: true,
      tags: true,
      groups: groupClaims,
      updatedAt: true,
      publishedAt: true,
      announced: true,
      subscribersEmailedAt: true,
      collecting: true,
      sample: true,
      importedPublishedAt: true,
      cover: { select: { id: true, status: true, width: true, height: true } },
      posts: { select: { post: { select: { number: true } } } },
      pullRequests: { select: { repo: true, number: true, title: true, url: true }, orderBy: [{ createdAt: "asc" }, { url: "asc" }] },
    },
  });
  if (!entry) {
    notFound();
  }
  const listed = entry.posts.map(({ post }) => post.number);
  const posts = await entryPosts(membership.project.id, listed);
  // Who publishing emails, as a Completed dialog counts them: the people behind the posts it completes (not sample ones).
  const completing = posts.filter((post) => post.status !== "COMPLETED" && post.status !== "CLOSED").map((post) => post.id);
  const emails = [...(await emailedOnCompletion(membership.project.id, completing)).values()].reduce((sum, n) => sum + n, 0);
  // Out of AI credits: the AI buttons stay, disabled (the banner above every project page says why).
  const paused = aiEnabled() && (await aiPaused(membership.project.id));
  // Emailed, but not to everyone yet (held, or unpublished before they all went): publishing again sends the rest.
  const left = await subscribersLeft(entry.id);
  // Who it actually went to: a send stopped short (its portal made private, say) says so.
  const sent = await prisma.changelogEmail.count({ where: { entryId: entry.id, sentAt: { not: null } } });
  // Emailed before it was imported (to the other tool's subscribers), not by Tuti: said so, not as "0 subscribers".
  // Only when Tuti sent it to nobody; from any source (every one named, so the record's index finds the few there are).
  const imported =
    entry.subscribersEmailedAt &&
    sent === 0 &&
    (await prisma.importedRecord.findFirst({ where: { projectId: membership.project.id, source: { in: Object.values(ImportSource) }, kind: "changelog-emailed", localId: entry.id }, select: { source: true } }));
  // Counted as the email job picks them (changelogReach, the entry's groups); null on a private portal, which emails nobody.
  const subscribers = await subscriberCount(membership.project.id, entry.id);
  // A draft not written yet: Draft with AI is the editor's one AI action, in the top bar (Edit with AI has nothing to
  // edit). Published as it was, Edit with AI is back (Draft with AI is for drafts). Still the pull requests' titles,
  // or the one line each Autopilot wrote into the running draft: neither is release notes.
  const unwritten =
    entry.publishedAt !== null
      ? undefined
      : onlyPullRequestTitles(entry.content, entry.pullRequests)
        ? entry.body.trim()
          ? "titles"
          : "empty"
        : entry.pullRequests.length > 0 && onlyPullRequestTitles(entry.content, entry.pullRequests, await autopilotLines(membership.project.id, entry.pullRequests.map((pr) => pr.url)))
          ? "lines"
          : undefined;
  // In the text's column it's shown as wide as the column, so not at the sidebar thumbnail's size: the largest stored
  // up to 1600px.
  const cover = lastingImage(entry.cover);
  // Imported as a draft though published there: publishing keeps that date, quietly (changelog.publish).
  const importedOn = entry.importedPublishedAt && formatDate(entry.importedPublishedAt);
  const wideCoverUrl = cover && lastingMediaUrl(imageKey(cover.id, imageWidths(cover.width).filter((w) => w <= 1600).at(-1)!));
  // Readers' comments on it (an unpublished one keeps them, hidden from readers, deletable but not editable): the team moderates them here.
  const [comments, team] = await Promise.all([
    prisma.changelogComment.findMany({
      where: { entryId: entry.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, body: true, content: true, createdAt: true, asReader: true, author: { select: { id: true, name: true, image: true } } },
    }),
    prisma.teamMember.findMany({ where: { projectId: membership.project.id }, select: { userId: true } }),
  ]);
  // The cover designs with something to show for the entry as it's saved, and the one picked when nobody picks; where
  // uploads are set up (a composed cover is kept as one). `version`: its previews are drawn again after a save.
  const coverOf = mediaStorage() ? await coverContent(membership.project.id, entry) : null;
  const covers = coverOf && { designs: coverDesigns(coverOf), automatic: automaticDesign(coverOf), version: entry.updatedAt.getTime() };
  const commentMedia = await mediaUrls(...comments.map(displayDoc));
  // Its pull requests' section: with GitHub connected, or listing the ones it has. A draft's "Add changes…" adds to the
  // running draft, this one or the one named (started as Next release if there's none).
  const [github, runningDraft] = await Promise.all([
    prisma.githubInstallation.findUnique({ where: { projectId: membership.project.id }, select: { id: true } }),
    entry.collecting ? null : prisma.changelogEntry.findFirst({ where: { projectId: membership.project.id, collecting: true }, select: { title: true } }),
  ]);
  // Each as Autopilot shows it (PullRequestChip): who merged it when, and its activity page, where Autopilot read it.
  const read = entry.pullRequests.length
    ? await prisma.codeChange.findMany({
        where: { projectId: membership.project.id, url: { in: entry.pullRequests.map((pr) => pr.url) } },
        select: { id: true, url: true, author: true, mergedAt: true },
      })
    : [];
  const pullRequests =
    github || entry.pullRequests.length > 0
      ? {
          list: entry.pullRequests.map((pr) => {
            const change = read.find((each) => each.url === pr.url);
            return change ? { ...pr, id: change.id, author: change.author, mergedAt: change.mergedAt.toISOString() } : pr;
          }),
          canAdd: github !== null,
          addsTo: entry.collecting ? null : (runningDraft?.title ?? RUNNING_DRAFT_TITLE),
        }
      : null;
  const readerUrl = entry.publishedAt ? `${await portalAddress(slug)}/changelog/${entry.number}` : null;
  const commentUploads = mediaStorage() ? { projectSlug: slug, mediaUrls: commentMedia ?? {} } : undefined;

  return (
    // Save in the pane's header submits the form below, and says when it's saving. On phones the title shows once, the
    // form's (the heading stays for screen readers), and Save and Publish stay at the bottom of the screen.
    <ChangelogSaving>
      <PaneLayout>
        <Pane aria-label="Changelog entry">
          <PaneHeader
            back={{ href: `/app/${slug}/changelog`, label: "All entries" }}
            titleInForm
            title={entry.title}
            actions={
              <PageActions
                pinned
                more={
                  <>
                  {/* Where readers see it, as a post's page has it: once it's published. */}
                  {readerUrl && (
                    <a href={readerUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "ghost" }), "h-auto justify-start gap-1.5 rounded-md px-1.5 py-1 font-normal")}>
                      <ExternalLinkIcon />
                      View on portal
                    </a>
                  )}
                  <ChangelogEntryActions
                    projectSlug={slug}
                    number={entry.number}
                    title={entry.title}
                    published={entry.publishedAt !== null}
                    postCount={completing.length}
                    emails={emails}
                    sample={entry.sample}
                    canDraftWithAi={aiEnabled() && entry.publishedAt === null}
                    aiPaused={paused}
                    part="delete"
                  />
                  </>
                }
              >
                <ChangelogEntryActions
                  projectSlug={slug}
                  number={entry.number}
                  title={entry.title}
                  published={entry.publishedAt !== null}
                  postCount={completing.length}
                  subscribers={subscribers ?? 0}
                  emailedSubscribers={entry.subscribersEmailedAt !== null}
                  subscribersLeft={left}
                  emails={emails}
                  sample={entry.sample}
                  importedOn={importedOn}
                  canDraftWithAi={aiEnabled() && entry.publishedAt === null}
                  aiPaused={paused}
                  unwritten={unwritten}
                  // What an AI draft left to fill in: Publish waits for them (changelog.publish refuses it too).
                  markers={entry.publishedAt ? [] : markersIn(displayDoc(entry))}
                  // Offered while it has no cover: Publish can add one.
                  covers={entry.cover ? null : covers}
                  part="publish"
                />
              </PageActions>
            }
          />
          <PaneBody className="lg:[container-type:size] flex flex-col gap-4 p-4 @min-[48rem]/app:px-8 @min-[48rem]/app:py-6">
            {/*
              New saved text (an AI draft, a save, a merged pull request added to the running draft) starts the form
              afresh; publishing or unpublishing keeps unsaved edits, and so does a new saved cover (one composed in
              the Publish dialog or by "Make a cover": the form's cover follows it, FeaturedImage).
            */}
            <ChangelogForm
              key={createHash("sha256").update(JSON.stringify([entry.title, entry.content])).digest("base64url")}
              projectSlug={slug}
              entry={{
                number: entry.number,
                title: entry.title,
                content: displayDoc(entry) as Doc,
                tags: entry.tags.map((t) => t.toLowerCase() as TagName),
                groups: claimsOf(entry),
                posts: listed,
                published: entry.publishedAt !== null,
                cover,
                wideCoverUrl,
                told: entry.publishedAt ? await entryTold(entry.id) : null,
                announced: entry.announced,
                emailedSubscribers: entry.subscribersEmailedAt !== null,
                subscribersLeft: left,
                subscribersSent: sent,
                emailedFrom: imported ? IMPORT_SOURCES[imported.source.toLowerCase() as ImportSourceKey].name : null,
                sample: entry.sample,
                importedOn,
                emailPaused: await projectEmailWaits(membership.project.id),
              }}
              subscribers={subscribers}
              groups={await prisma.readerGroup.findMany({ where: { projectId: membership.project.id }, orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true } })}
              posts={posts}
              standing={
                <>
                  {entry.sample && <SampleBadge />}{" "}
                  {entry.publishedAt
                    ? `Published ${formatDate(entry.publishedAt)}`
                    : entry.collecting
                      ? "Draft, collecting merged pull requests until a release or you publish it"
                      : "Draft"}
                </>
              }
              mediaUrls={await mediaUrls(displayDoc(entry))}
              covers={covers}
              canEditWithAi={aiEnabled() && !unwritten}
              aiPaused={paused}
              pullRequests={pullRequests}
            />
            {/* Always there, so focus has its heading to go to once the last is deleted. */}
            <section className="flex max-w-3xl flex-col gap-4 border-t pt-6" aria-label="Comments">
              <h2 id={COMMENTS_HEADING} tabIndex={-1} className="text-sm font-semibold outline-none">
                {comments.length === 0 ? (
                  <span className="font-normal text-muted-foreground">
                    {entry.publishedAt ? "No comments yet. Users comment on it on your portal." : "No comments. Users comment on it on your portal once it's published."}
                  </span>
                ) : (
                  `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`
                )}
              </h2>
              {comments.length > 0 && (
                <CommentList
                  comments={comments}
                  teamUserIds={new Set(team.map((m) => m.userId))}
                  mediaUrls={commentMedia}
                  // The team deletes any (moderation); its own it edits too.
                  editable={(comment, text) => (
                    <ChangelogComment
                      projectSlug={slug}
                      number={entry.number}
                      commentId={comment.id}
                      author={comment.author.name}
                      doc={displayDoc(comment)}
                      mine={comment.author.id === membership.userId}
                      canEdit={comment.author.id === membership.userId && entry.publishedAt !== null}
                      canDelete
                      uploads={commentUploads}
                    >
                      {text}
                    </ChangelogComment>
                  )}
                />
              )}
            </section>
          </PaneBody>
        </Pane>
      </PaneLayout>
    </ChangelogSaving>
  );
}
