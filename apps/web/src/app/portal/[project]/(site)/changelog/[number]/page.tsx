import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BackLink } from "@/components/back-link";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { ChangelogMenu, changelogByEmail } from "@/components/changelog-pages";
import { publishedEntries } from "@/server/changelog-queries";
import { getSession } from "@/server/session";
import { portalBase, portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";
import { portalArticleJsonLd, portalPageMetadata } from "@/server/portal-metadata";
import { summary } from "@/lib/article-links";

/** A published entry's search listing, once per request (its metadata and its page's JSON-LD). */
const listedEntry = cache(async (project: string, number: string) =>
  /^\d{1,9}$/.test(number)
    ? prisma.changelogEntry.findFirst({
        where: { project: { slug: project }, number: Number(number), publishedAt: { not: null } },
        select: { title: true, body: true, publishedAt: true, sample: true },
      })
    : null,
);

/** An entry's search listing and link card; sample content (server/sample-content.ts) is kept from search engines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/changelog/[number]">): Promise<Metadata> {
  const { project, number } = await props.params;
  const entry = await listedEntry(project, number);
  if (!entry) {
    return {};
  }
  return portalPageMetadata(project, {
    title: entry.title,
    description: summary(entry.body),
    path: `/changelog/${Number(number)}`,
    article: { publishedTime: entry.publishedAt },
    noindex: entry.sample,
  });
}

export default async function ChangelogEntryPage(props: PageProps<"/portal/[project]/changelog/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  if (!Number.isInteger(number) || number < 1) {
    notFound();
  }
  const session = await getSession();
  const [[entry], project] = await Promise.all([
    publishedEntries(slug, { number, take: 1, userId: session?.user.id }),
    prisma.project.findUnique({ where: { slug }, select: { id: true, name: true, portalAccess: true } }),
  ]);
  if (!entry) {
    notFound();
  }
  // For search engines (every entry is for signed-out readers too); sample content isn't for them, as in generateMetadata.
  const listed = await listedEntry(slug, param);
  const jsonLd =
    listed &&
    !listed.sample &&
    (await portalArticleJsonLd(slug, {
      type: "BlogPosting",
      title: listed.title,
      description: summary(listed.body),
      path: `/changelog/${number}`,
      // Its publishing date alone: emails going out change updatedAt too.
      published: listed.publishedAt,
    }));
  return (
    <div className="flex flex-col gap-6">
      {jsonLd}
      <ChangelogMenu slug={slug} current={entry.number} />
      <ChangelogEntryView
        entry={entry}
        back={<BackLink href={(await portalLinks())("/changelog")}>Changelog</BackLink>}
        mediaUrls={await mediaUrls(entry.doc, entry.cover)}
        heading="h1"
        react={{ projectSlug: slug, signedIn: !!session }}
        base={await portalBase()}
      />
      {/* After reading: the way to hear about the next one. */}
      {project && <div className="mt-4 border-t pt-8">{await changelogByEmail({ ...project, slug }, session)}</div>}
    </div>
  );
}
