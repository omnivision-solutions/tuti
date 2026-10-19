import { mediaPublicUrl } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { ChangelogForm } from "@/components/changelog";
import { PageHeader } from "@/components/page-header";
import { STATUS_LABELS } from "@/components/post-status-badge";
import { completablePosts } from "@/server/changelog-pages";
import { getMembership } from "@/server/membership";

export default async function NewChangelogEntryPage(props: PageProps<"/app/[project]/changelog/new">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const posts = await completablePosts(membership.project.id);
  return (
    <>
      <PageHeader title="New changelog entry" description="It stays a draft until you publish it." />
      <ChangelogForm
        projectSlug={slug}
        entry={null}
        posts={posts.map((p) => ({ ...p, status: STATUS_LABELS[p.status] }))}
        mediaBaseUrl={mediaPublicUrl()}
      />
    </>
  );
}
