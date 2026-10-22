import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ArticleForm } from "@/components/docs";
import { PageHeader } from "@/components/page-header";
import { collectionOptions } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { MAX_ARTICLE_TITLE } from "@/server/operations/docs";
import { mediaUrls } from "@/server/media-urls";

/** A new article; `?title=` starts it with that title (a gap's "Write an article"), `?collection=` in that collection (a "+" in the tree). */
export default async function NewArticlePage(props: PageProps<"/app/[project]/docs/new">) {
  const [{ project: slug }, { title, collection }] = await Promise.all([props.params, props.searchParams]);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const collections = await collectionOptions(membership.project.id);
  return (
    <>
      <BackLink href={`/app/${slug}/docs`}>Docs</BackLink>
      <PageHeader title="New article" description="It stays a draft until you publish it." />
      <ArticleForm
        // Another "+" starts it afresh in its collection.
        key={String(collection ?? "")}
        projectSlug={slug}
        article={null}
        collections={collections}
        mediaUrls={await mediaUrls()}
        defaultTitle={typeof title === "string" ? title.trim().slice(0, MAX_ARTICLE_TITLE) : undefined}
        defaultCollection={collections.find((c) => c.slug === collection)?.slug}
      />
    </>
  );
}
