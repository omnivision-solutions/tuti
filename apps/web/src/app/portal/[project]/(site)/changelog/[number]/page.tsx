import { mediaPublicUrl } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { publishedEntries } from "@/server/changelog-queries";
import { getSession } from "@/server/session";

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
      <BackLink href="/changelog">Changelog</BackLink>
      <ChangelogEntryView
        entry={entry}
        mediaBaseUrl={mediaPublicUrl()}
        heading="h1"
        react={{ projectSlug: slug, signedIn: !!session }}
      />
    </div>
  );
}
