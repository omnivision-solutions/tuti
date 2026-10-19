import { mediaPublicUrl } from "@tuti/shared/storage";

import { ChangelogEntryView } from "@/components/changelog-entry";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Separator } from "@/components/ui/separator";
import { publishedEntries } from "@/server/changelog-portal";

/** What shipped, newest first. */
export default async function ChangelogPage(props: PageProps<"/portal/[project]/changelog">) {
  const { project: slug } = await props.params;
  const entries = await publishedEntries(slug);
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Changelog" description="What's new, improved and fixed." />
      {entries.length === 0 ? (
        <EmptyState title="Nothing here yet" description="New features and fixes show up here as they ship." />
      ) : (
        entries.map((entry, i) => (
          <div key={entry.number} className="flex flex-col gap-8">
            {i > 0 && <Separator />}
            <ChangelogEntryView entry={entry} mediaBaseUrl={mediaPublicUrl()} />
          </div>
        ))
      )}
    </div>
  );
}
