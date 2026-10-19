import { mediaPublicUrl } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ArticleForm } from "@/components/help";
import { PageHeader } from "@/components/page-header";
import { collectionOptions } from "@/server/help-queries";
import { getMembership } from "@/server/membership";

export default async function NewArticlePage(props: PageProps<"/app/[project]/help/new">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  return (
    <>
      <BackLink href={`/app/${slug}/help`}>Help center</BackLink>
      <PageHeader title="New article" description="It stays a draft until you publish it." />
      <ArticleForm
        projectSlug={slug}
        article={null}
        collections={await collectionOptions(membership.project.id)}
        mediaBaseUrl={mediaPublicUrl()}
      />
    </>
  );
}
