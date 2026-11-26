import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { DocsArticle, DocsCollectionPage, docsPageListing, DocsTabPage } from "@/components/portal-docs";
import { ApiReferenceLanding, referenceListing } from "@/components/portal-api-operation";
import { apiReferencePage } from "@/server/api-reference-queries";
import { articleNamed, docsPage } from "@/server/docs-queries";
import { portalLinks } from "@/server/portal-base";
import { portalPageMetadata } from "@/server/portal-metadata";

/**
 * Search results show the page's title and its first lines (an article's) or its description (a
 * collection's). A tab showing an article or collection in its place has that one's, with the tab's
 * address as canonical.
 */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs/[slug]">): Promise<Metadata> {
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  const path = `/docs/${slug}`;
  if (!page) {
    // An API reference's, else none.
    const listing = await referenceListing(project, slug);
    return listing ? portalPageMetadata(project, { ...listing, path }) : {};
  }
  if (page.kind === "redirect") {
    return {};
  }
  if (page.kind === "tab") {
    if (page.tab.locked || page.landing.kind === "overview") {
      return portalPageMetadata(project, { title: `${page.tab.name} · Documentation`, path, noindex: page.tab.locked });
    }
    if (page.landing.kind === "reference") {
      return portalPageMetadata(project, { ...((await referenceListing(project, page.landing.slug)) ?? { title: page.landing.name }), path });
    }
    return portalPageMetadata(project, { ...docsPageListing(page.landing), path });
  }
  // An article's page is in the default language until its translations (L8): canonical there, by its default-language slug.
  const article = page.kind === "article" || page.kind === "locked" ? await articleNamed(project, slug) : null;
  return portalPageMetadata(project, { ...docsPageListing(page), path: article ? `/docs/${article.slug}` : path, markdown: page.kind === "article" });
}

/** /docs/<slug>: an article, a tab, a collection or an API reference (one name each), or where one went since. */
export default async function DocsSlugPage(props: PageProps<"/portal/[project]/docs/[slug]">) {
  const at = await portalLinks();
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  if (!page) {
    // An API reference's, else a 404.
    if (!(await apiReferencePage(project, slug))) {
      notFound();
    }
    return <ApiReferenceLanding project={project} slug={slug} />;
  }
  if (page.kind === "redirect") {
    permanentRedirect(at(page.path));
  }
  switch (page.kind) {
    case "tab":
      return <DocsTabPage project={project} docs={page.docs} tab={page.tab} landing={page.landing} path={`/docs/${slug}`} />;
    case "collection":
      return <DocsCollectionPage page={page} />;
    case "article":
    case "locked":
      return <DocsArticle project={project} slug={slug} article={page.article} />;
  }
}
