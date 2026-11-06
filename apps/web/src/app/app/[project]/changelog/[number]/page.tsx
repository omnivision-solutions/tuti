import { createHash } from "node:crypto";

import type { Doc } from "@tuti/content";
import { imageKey, imageWidths } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { aiPaused, onlyPullRequestTitles, projectEmailWaits, subscriberCount, subscribersLeft } from "@tuti/jobs";
import { aiEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { ChangelogEntryActions, ChangelogForm, ChangelogSaving, type TagName } from "@/components/changelog";
import { PageHeader } from "@/components/page-header";
import { SampleBadge } from "@/components/sample-badge";
import { formatDate } from "@/lib/format";
import { entryPosts, entryTold } from "@/server/changelog-queries";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { displayDoc } from "@/server/content";
import { portalAddress } from "@/server/custom-domains";
import { getMembership } from "@/server/membership";
import { lastingImage, lastingMediaUrl, mediaUrls } from "@/server/media-urls";

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
      publishedAt: true,
      announced: true,
      subscribersEmailedAt: true,
      collecting: true,
      sample: true,
      cover: { select: { id: true, status: true, width: true, height: true } },
      posts: { select: { post: { select: { number: true } } } },
      pullRequests: { select: { repo: true, number: true, title: true } },
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
  // Emailed before it was imported (to Featurebase's subscribers), not by Tuti: said so, not as "0 subscribers".
  const imported = entry.subscribersEmailedAt && (await prisma.importedRecord.findFirst({ where: { projectId: membership.project.id, kind: "changelog-emailed", localId: entry.id }, select: { id: true } }));
  // Counted as the email job picks them (changelogReach); null on a private portal, which emails nobody.
  const subscribers = await subscriberCount(membership.project.id);
  // A draft not written yet: Draft with AI is the editor's one AI action, in the top bar (Edit with AI has nothing to
  // edit). Published as it was, Edit with AI is back (Draft with AI is for drafts).
  const unwritten =
    entry.publishedAt === null && onlyPullRequestTitles(entry.content, entry.pullRequests) ? (entry.body.trim() ? "titles" : "empty") : undefined;
  // In the text's column it's shown as wide as the column, so not at the sidebar thumbnail's size: the largest stored
  // up to 1600px.
  const cover = lastingImage(entry.cover);
  const wideCoverUrl = cover && lastingMediaUrl(imageKey(cover.id, imageWidths(cover.width).filter((w) => w <= 1600).at(-1)!));

  return (
    // Save in the top bar submits the form below, and says when it's saving. On phones the title shows once, the form's
    // (the heading stays for screen readers), and Save and Publish stay at the bottom of the screen.
    <ChangelogSaving>
      <PageHeader
        title={entry.title}
        className="phonebar:[&_h1]:sr-only"
        pinActions
        meta={
          <>
            {entry.sample && <SampleBadge />}{" "}
            {entry.publishedAt
              ? `Published ${formatDate(entry.publishedAt)}`
              : entry.collecting
                ? "Draft · collecting merged pull requests until a release or you publish it"
                : "Draft"}
          </>
        }
        actions={
          <ChangelogEntryActions
            projectSlug={slug}
            number={entry.number}
            title={entry.title}
            published={entry.publishedAt !== null}
            postCount={listed.length}
            subscribers={subscribers ?? 0}
            emailedSubscribers={entry.subscribersEmailedAt !== null}
            subscribersLeft={left}
            emails={emails}
            sample={entry.sample}
            canDraftWithAi={aiEnabled() && entry.publishedAt === null}
            aiPaused={paused}
            unwritten={unwritten}
            part="publish"
          />
        }
        more={
          <ChangelogEntryActions
            projectSlug={slug}
            number={entry.number}
            title={entry.title}
            published={entry.publishedAt !== null}
            postCount={listed.length}
            emails={emails}
            sample={entry.sample}
            canDraftWithAi={aiEnabled() && entry.publishedAt === null}
            aiPaused={paused}
            part="delete"
          />
        }
      />
      {/*
        New saved text or cover (an AI draft, a save, a merged pull request added to the running draft)
        starts the form afresh; publishing or unpublishing keeps unsaved edits.
      */}
      <ChangelogForm
        key={createHash("sha256").update(JSON.stringify([entry.title, entry.content, entry.cover?.id])).digest("base64url")}
        projectSlug={slug}
        entry={{
          number: entry.number,
          title: entry.title,
          content: displayDoc(entry) as Doc,
          tags: entry.tags.map((t) => t.toLowerCase() as TagName),
          posts: listed,
          published: entry.publishedAt !== null,
          cover,
          wideCoverUrl,
          told: entry.publishedAt ? await entryTold(entry.id) : null,
          announced: entry.announced,
          emailedSubscribers: entry.subscribersEmailedAt !== null,
          subscribersLeft: left,
          subscribersSent: sent,
          // Featurebase is the only tool imports come from.
          emailedFrom: imported ? "Featurebase" : null,
          sample: entry.sample,
          emailPaused: await projectEmailWaits(membership.project.id),
        }}
        subscribers={subscribers}
        posts={posts}
        readerUrl={entry.publishedAt ? `${await portalAddress(slug)}/changelog/${entry.number}` : null}
        mediaUrls={await mediaUrls(displayDoc(entry))}
        canEditWithAi={aiEnabled() && !unwritten}
        aiPaused={paused}
      />
    </ChangelogSaving>
  );
}
