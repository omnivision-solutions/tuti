import { mediaPublicUrl } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { publishedEntries } from "@/server/changelog-portal";

export default async function ChangelogEntryPage(props: PageProps<"/portal/[project]/changelog/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  if (!Number.isInteger(number) || number < 1) {
    notFound();
  }
  const [entry] = await publishedEntries(slug, { number, take: 1 });
  if (!entry) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/changelog">Changelog</BackLink>
      <ChangelogEntryView entry={entry} mediaBaseUrl={mediaPublicUrl()} heading="h1" />
    </div>
  );
}
