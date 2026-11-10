import { notFound } from "next/navigation";

import { ArticleSettings } from "@/components/article-settings";
import {
  ArticleEditor,
  ArticleForm,
  ArticleSaveButton,
} from "@/components/docs";
import { DocsPageHeader } from "@/components/docs-page-header";
import { collectionOptions } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { MAX_ARTICLE_TITLE } from "@/server/operations/docs";
import { mediaUrls } from "@/server/media-urls";

/** A new article; `?title=` starts it with that title (a gap's "Write an article"), `?collection=` in that collection (a "+" in the tree). */
export default async function NewArticlePage(
  props: PageProps<"/app/[project]/docs/new">,
) {
  const [{ project: slug }, { title, collection }] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const collections = await collectionOptions(membership.project.id);
  return (
    // Another "+" starts it afresh in its collection.
    <ArticleEditor
      key={String(collection ?? "")}
      collections={collections}
      defaultCollection={collections.find((c) => c.slug === collection)?.slug}
    >
      <section className="docs-editor-page docs-new-article docs-surface">
        <DocsPageHeader
          title="New article"
          back={{ href: `/app/${slug}/docs`, label: "Docs" }}
          actions={
            <>
              <span className="text-xs text-muted-foreground">
                Not saved yet
              </span>
              <ArticleSettings />
              <ArticleSaveButton label="Save draft" filled />
            </>
          }
        />
        <div id="article-toolbar" className="docs-format-row" />
        <div className="docs-editor-scroll">
          <ArticleForm
            projectSlug={slug}
            article={null}
            mediaUrls={await mediaUrls()}
            defaultTitle={
              typeof title === "string"
                ? title.trim().slice(0, MAX_ARTICLE_TITLE)
                : undefined
            }
          />
        </div>
      </section>
    </ArticleEditor>
  );
}
