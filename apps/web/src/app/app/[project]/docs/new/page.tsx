import { mediaPublicUrl } from "@tuti/shared/storage";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ArticleForm } from "@/components/docs";
import { PageHeader } from "@/components/page-header";
import { accessChoices, collectionOptions } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { MAX_ARTICLE_TITLE } from "@/server/operations/docs";

/** A new article; `?title=` starts it with that title (a gap's "Write an article"). */
export default async function NewArticlePage(props: PageProps<"/app/[project]/docs/new">) {
  const [{ project: slug }, { title }] = await Promise.all([props.params, props.searchParams]);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  return (
    <>
      <BackLink href={`/app/${slug}/docs`}>Docs</BackLink>
      <PageHeader title="New article" description="It stays a draft until you publish it." />
      <ArticleForm
        projectSlug={slug}
        article={null}
        collections={await collectionOptions(membership.project.id)}
        access={await accessChoices(membership.project.id)}
        mediaBaseUrl={mediaPublicUrl()}
        defaultTitle={typeof title === "string" ? title.trim().slice(0, MAX_ARTICLE_TITLE) : undefined}
      />
    </>
  );
}
