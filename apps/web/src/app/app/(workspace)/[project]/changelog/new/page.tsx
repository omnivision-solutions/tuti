import { notFound } from "next/navigation";

import { ChangelogForm, ChangelogSaveButton, ChangelogSaving } from "@/components/changelog";
import { PageActions } from "@/components/page-actions";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";

export default async function NewChangelogEntryPage(props: PageProps<"/app/[project]/changelog/new">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  return (
    // Save draft in the pane's header (at the bottom of the screen on phones) submits the form below, and says when it's saving.
    <ChangelogSaving>
      <PaneLayout>
        <Pane aria-label="New changelog entry">
          <PaneHeader
            back={{ href: `/app/${slug}/changelog`, label: "All entries" }}
            titleInForm
            title="New changelog entry"
            actions={
              <PageActions pinned>
                <ChangelogSaveButton isNew />
              </PageActions>
            }
          />
          <PaneBody className="lg:[container-type:size] p-4 @min-[48rem]/app:px-8 @min-[48rem]/app:py-6">
            <ChangelogForm projectSlug={slug} entry={null} posts={[]} readerUrl={null} mediaUrls={await mediaUrls()} />
          </PaneBody>
        </Pane>
      </PaneLayout>
    </ChangelogSaving>
  );
}
