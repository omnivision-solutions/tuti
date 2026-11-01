import { notFound } from "next/navigation";

import { ChangelogForm, ChangelogSaveButton, ChangelogSaving } from "@/components/changelog";
import { PageHeader } from "@/components/page-header";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";

export default async function NewChangelogEntryPage(props: PageProps<"/app/[project]/changelog/new">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  return (
    // Save draft in the top bar submits the form below, and says when it's saving.
    <ChangelogSaving>
      <PageHeader title="New changelog entry" actions={<ChangelogSaveButton isNew />} />
      <ChangelogForm projectSlug={slug} entry={null} posts={[]} readerUrl={null} mediaUrls={await mediaUrls()} />
    </ChangelogSaving>
  );
}
