import { createHash } from "node:crypto";

import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { aiEnabled } from "@tuti/shared";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { ChangelogEntryActions, ChangelogForm, type TagName } from "@/components/changelog";
import { PageHeader } from "@/components/page-header";
import { STATUS_LABELS } from "@/components/post-status-badge";
import { formatDate } from "@/lib/format";
import { completablePosts } from "@/server/changelog-queries";
import { displayDoc } from "@/server/content";
import { getMembership } from "@/server/membership";

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
      number: true,
      title: true,
      body: true,
      content: true,
      tags: true,
      publishedAt: true,
      collecting: true,
      posts: { select: { post: { select: { number: true } } } },
    },
  });
  if (!entry) {
    notFound();
  }
  const listed = entry.posts.map(({ post }) => post.number);
  const posts = await completablePosts(membership.project.id, listed);

  return (
    <>
      <PageHeader
        title={entry.title}
        description={
          entry.publishedAt
            ? `Published ${formatDate(entry.publishedAt)}`
            : entry.collecting
              ? "Draft · merged pull requests are added here until a release closes it, or you publish it"
              : "Draft"
        }
        actions={
          <ChangelogEntryActions
            projectSlug={slug}
            number={entry.number}
            title={entry.title}
            published={entry.publishedAt !== null}
            postCount={listed.length}
            canDraftWithAi={aiEnabled() && entry.publishedAt === null}
          />
        }
      />
      {/*
        New saved text (an AI draft, a save, a merged pull request added to the running draft)
        starts the form afresh; publishing or unpublishing keeps unsaved edits.
      */}
      <ChangelogForm
        key={createHash("sha256").update(JSON.stringify([entry.title, entry.content])).digest("base64url")}
        projectSlug={slug}
        entry={{
          number: entry.number,
          title: entry.title,
          content: displayDoc(entry) as Doc,
          tags: entry.tags.map((t) => t.toLowerCase() as TagName),
          posts: listed,
          published: entry.publishedAt !== null,
        }}
        posts={posts.map((p) => ({ ...p, status: STATUS_LABELS[p.status] }))}
        mediaBaseUrl={mediaPublicUrl()}
        canEditWithAi={aiEnabled()}
      />
    </>
  );
}
