import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { ChangelogMenu, changelogByEmail } from "@/components/changelog-pages";
import { publishedEntries } from "@/server/changelog-queries";
import { getSession } from "@/server/session";
import { portalBase, portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";

/** Sample content (server/sample-content.ts) is kept from search engines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/changelog/[number]">): Promise<Metadata> {
  const { project, number } = await props.params;
  const sample = /^\d{1,9}$/.test(number) && (await prisma.changelogEntry.count({ where: { project: { slug: project }, number: Number(number), sample: true } })) > 0;
  return sample ? { robots: { index: false } } : {};
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
  return (
    <div className="flex flex-col gap-6">
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
