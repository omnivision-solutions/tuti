import { cn } from "cn";
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
      <section className={cn(
        "docs-editor-page [&_.article-text_p]:relative [&_.article-text_blockquote]:relative [&_.article-text_blockquote]:rounded-[10px]",
        "[&_.article-text_blockquote]:border-0 [&_.article-text_blockquote]:bg-secondary [&_.article-text_blockquote]:py-3",
        "[&_.article-text_blockquote]:pr-4 [&_.article-text_blockquote]:pl-10 [&_.article-text_blockquote]:text-foreground",
        "[&_.article-text_blockquote]:text-[14px] [&_.article-text_blockquote]:before:absolute [&_.article-text_blockquote]:before:left-3",
        "[&_.article-text_blockquote]:before:top-3.5 [&_.article-text_blockquote]:before:text-primary",
        "[&_.article-text_blockquote]:before:content-['ⓘ'] docs-new-article docs-surface flex flex-col flex-1 min-w-0 overflow-hidden",
        "@max-[61rem]/app:[&_.docs-article-form]:px-7 @max-[61rem]/app:[&_.docs-article-form]:max-w-[min(43rem,_calc(100%_-_56px))]",
        "max-sm:rounded-[14px]",
        "max-sm:[&_.docs-article-form]:p-[20px_23px_48px] max-sm:[&_.docs-article-form]:max-w-[calc(100%_-_46px)]",
        "[&_.article-text]:text-[16px] [&_.article-text]:leading-[1.75]",
        "[&_.article-text]:gap-3.5 [&_.article-text_h2]:text-[23px] [&_.article-text_h2]:mt-4 [&_.article-text_h2]:leading-[1.3]",
        "[&_.article-text_h3]:text-[19px] [&_.article-text_h3]:mt-3 [&_.article-text_li_+_li]:mt-1 max-sm:[&_.article-text]:text-[15px]",
        "max-sm:[&_.article-text]:leading-[1.7] max-sm:[&_.article-text_h2]:text-[21px] max-sm:[&_.article-text_h2]:mt-5",
        "[&_>_.docs-page-header]:p-[23px_28px_18px] [&_.docs-article-form]:pt-10.5 max-sm:[&_>_.docs-page-header]:p-[16px_20px]",
        "max-sm:[&_.docs-heading-copy_h1]:text-[25px] max-sm:[&_.docs-heading-actions_>_span]:mr-auto",
        "[&_.docs-article-form_>_[data-slot='field-group']]:gap-3.5 [&_#new-article-place]:absolute [&_#new-article-place]:w-0.25",
        "[&_#new-article-place]:h-0.25 [&_#new-article-place]:overflow-hidden [&_#new-article-place]:[clip-path:inset(50%)]",
        "[&_[aria-labelledby='new-article-place']]:border-0 [&_[aria-labelledby='new-article-place']]:shadow-none [&_[aria-labelledby='new-article-place']]:ring-0",
        "[&_[aria-labelledby='new-article-place']]:bg-transparent max-sm:[&_.docs-article-form]:pt-7.75",
        "max-sm:[&_.docs-heading-actions_[data-slot='button']]:w-auto max-sm:[&_.docs-heading-actions_[data-slot='button']]:px-2",
        "max-sm:[&_.docs-heading-actions_[data-slot='button']]:text-xs max-sm:[&_.docs-format-row_button[aria-label='Code']]:inline-flex",
        "max-sm:[&_.docs-format-row_[aria-label='Quote']]:inline-flex max-sm:[&_.docs-format-row_button[aria-label='Table']]:inline-flex min-w-0",
        "min-h-0 rounded-[14px] bg-docs-surface",
        "shadow-[0_1px_3px_color-mix(in_oklch,_var(--foreground)_3.5%,_transparent),_0_0_0_1px_var(--docs-edge)]",
      )}>
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
        <div id="article-toolbar" className={cn(
          "docs-format-row flex items-center gap-2.5 shrink-0 min-h-12 p-[5px_18px] border-b border-border bg-docs-surface z-15",
          "[&_>_[aria-label='Formatting']]:flex-nowrap [&_>_[aria-label='Formatting']]:min-w-0 [&_>_[aria-label='Formatting']]:overflow-x-auto",
          "[&_>_[aria-label='Formatting']]:[scrollbar-width:none] [&_[data-slot='button']]:min-w-7.25 [&_[data-slot='button']]:h-7.5",
          "[&_[data-slot='button']]:text-muted-foreground [&_svg]:w-4 [&_svg]:h-4 @max-[77rem]/app:px-3 @max-[77rem]/app:gap-1 @max-[77rem]/app:[&_[aria-label='Quote']]:hidden",
          "@max-[77rem]/app:[&_button[aria-label='Code']]:hidden @max-[77rem]/app:[&_button[aria-label='Table']]:hidden max-sm:px-2.5 max-sm:gap-0.75 max-sm:min-h-11",
          "max-sm:[&_>_[aria-label='Formatting']]:gap-0 max-sm:[&_[data-slot='button']]:min-w-6.25 max-sm:[&_[data-slot='button']]:h-7",
          "max-sm:[&_[data-slot='button']]:p-0 max-sm:[&_svg]:w-3.75 max-sm:[&_svg]:h-3.75 max-sm:[&_.docs-toolbar-separator]:mx-0.5",
          "max-sm:[&_[aria-label='Quote']]:hidden max-sm:[&_button[aria-label='Code']]:hidden max-sm:[&_button[aria-label='Table']]:hidden",
          "[&_[data-slot='button']:has(svg:only-child)]:w-7.25 [&_[data-slot='button']:has(svg:only-child)]:px-0",
          "max-sm:[&_[data-slot='button']:has(svg:only-child)]:w-6.25",
        )} />
        <div className="docs-editor-scroll overflow-auto min-h-0 flex-1 [scrollbar-width:thin] [scroll-padding-top:24px]">
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
