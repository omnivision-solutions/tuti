import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";

import { DocsArticle, DocsCollectionPage, docsPageListing, DocsTabPage } from "@/components/portal-docs";
import { apiReferencePage } from "@/server/api-reference-queries";
import { docsPage } from "@/server/docs-queries";
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
  if (!page || page.kind === "redirect") {
    return {};
  }
  const path = `/docs/${slug}`;
  if (page.kind === "tab") {
    if (page.tab.locked || page.landing.kind === "overview") {
      return portalPageMetadata(project, { title: `${page.tab.name} · Documentation`, path, noindex: page.tab.locked });
    }
    return portalPageMetadata(project, { ...docsPageListing(page.landing), path });
  }
  return portalPageMetadata(project, { ...docsPageListing(page), path, markdown: page.kind === "article" });
}

/** /docs/<slug>: an article, a tab or a collection (one name each), or where one went since; an API reference's goes to its first operation. */
export default async function DocsSlugPage(props: PageProps<"/portal/[project]/docs/[slug]">) {
  const at = await portalLinks();
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  if (!page) {
    // An API reference has no page of its own yet: its first operation's.
    const first = (await apiReferencePage(project, slug))?.operations[0];
    if (first) {
      redirect(at(`/docs/${slug}/${first.slug}`));
    }
    notFound();
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
