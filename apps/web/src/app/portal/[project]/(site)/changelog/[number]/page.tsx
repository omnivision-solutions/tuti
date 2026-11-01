import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { ChangelogMenu } from "@/components/changelog-pages";
import { publishedEntries } from "@/server/changelog-queries";
import { getSession } from "@/server/session";
import { portalBase, portalLinks } from "@/server/portal-base";
import { mediaUrls } from "@/server/media-urls";

export default async function ChangelogEntryPage(props: PageProps<"/portal/[project]/changelog/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  if (!Number.isInteger(number) || number < 1) {
    notFound();
  }
  const session = await getSession();
  const [entry] = await publishedEntries(slug, { number, take: 1, userId: session?.user.id });
  if (!entry) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <ChangelogMenu slug={slug} current={entry.number} />
      <BackLink href={(await portalLinks())("/changelog")}>Changelog</BackLink>
      <ChangelogEntryView
        entry={entry}
        mediaUrls={await mediaUrls(entry.doc, entry.cover)}
        heading="h1"
        react={{ projectSlug: slug, signedIn: !!session }}
        base={await portalBase()}
      />
    </div>
  );
}
