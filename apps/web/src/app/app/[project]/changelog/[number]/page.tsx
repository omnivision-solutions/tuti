import { createHash } from "node:crypto";

import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { aiPaused, subscriberCount, subscribersLeft } from "@tuti/jobs";
import { aiEnabled } from "@tuti/shared";
import { notFound } from "next/navigation";

import { ChangelogEntryActions, ChangelogForm, ChangelogSaving, type TagName } from "@/components/changelog";
import { PageHeader } from "@/components/page-header";
import { formatDate } from "@/lib/format";
import { entryPosts, entryTold } from "@/server/changelog-queries";
import { displayDoc } from "@/server/content";
import { portalAddress } from "@/server/custom-domains";
import { getMembership } from "@/server/membership";
import { lastingImage, mediaUrls } from "@/server/media-urls";

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
      cover: { select: { id: true, status: true, width: true, height: true } },
      posts: { select: { post: { select: { number: true } } } },
    },
  });
  if (!entry) {
    notFound();
  }
  const listed = entry.posts.map(({ post }) => post.number);
  const posts = await entryPosts(membership.project.id, listed);
  // Out of AI credits: the AI buttons stay, disabled (the banner above every project page says why).
  const paused = aiEnabled() && (await aiPaused(membership.project.id));
  // Emailed, but not to everyone yet (held, or unpublished before they all went): publishing again sends the rest.
  const left = await subscribersLeft(entry.id);
  // Who it actually went to: a send stopped short (its portal made private, say) says so.
  const sent = await prisma.changelogEmail.count({ where: { entryId: entry.id, sentAt: { not: null } } });
  // Only a public portal's are emailed (changelog.publish): null on a private one, which has nobody to email.
  const { portalAccess } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { portalAccess: true } });
  // Counted as the email job picks them (past those who turned the project's emails off since).
  const subscribers = portalAccess === "PUBLIC" ? await subscriberCount(membership.project.id) : null;

  return (
    // Save in the top bar submits the form below, and says when it's saving.
    <ChangelogSaving>
      <PageHeader
        title={entry.title}
        meta={
          entry.publishedAt
            ? `Published ${formatDate(entry.publishedAt)}`
            : entry.collecting
              ? "Draft · collecting merged pull requests until a release or you publish it"
              : "Draft"
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
            canDraftWithAi={aiEnabled() && entry.publishedAt === null}
            aiPaused={paused}
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
          cover: lastingImage(entry.cover),
          told: entry.publishedAt ? await entryTold(entry.id) : null,
          announced: entry.announced,
          emailedSubscribers: entry.subscribersEmailedAt !== null,
          subscribersLeft: left,
          subscribersSent: sent,
        }}
        subscribers={subscribers}
        posts={posts}
        readerUrl={entry.publishedAt ? `${await portalAddress(slug)}/changelog/${entry.number}` : null}
        mediaUrls={await mediaUrls(displayDoc(entry))}
        canEditWithAi={aiEnabled()}
        aiPaused={paused}
      />
    </ChangelogSaving>
  );
}
