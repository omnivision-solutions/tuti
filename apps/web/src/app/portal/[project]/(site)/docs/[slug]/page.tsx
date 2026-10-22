import type { Metadata, ResolvingMetadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { DocsArticle, DocsCollectionPage, docsPageMetadata, DocsTabPage, withPortalOpenGraph } from "@/components/portal-docs";
import { portalAddress } from "@/server/custom-domains";
import { docsPage } from "@/server/docs-queries";
import { portalLinks } from "@/server/portal-base";

/**
 * Search results show the page's title and its first lines (an article's) or its description (a
 * collection's). A tab showing an article or collection in its place has that one's, with the tab's
 * address as canonical.
 */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs/[slug]">, parent?: ResolvingMetadata): Promise<Metadata> {
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  if (!page || page.kind === "redirect") {
    return {};
  }
  const canonical = { alternates: { canonical: `${await portalAddress(project)}/docs/${slug}` } };
  if (page.kind === "tab") {
    if (page.tab.locked) {
      return { title: `${page.tab.name} · Docs`, robots: { index: false }, ...canonical };
    }
    return withPortalOpenGraph({ ...(page.landing.kind === "overview" ? { title: `${page.tab.name} · Docs` } : docsPageMetadata(page.landing)), ...canonical }, parent);
  }
  return withPortalOpenGraph({ ...docsPageMetadata(page), ...canonical }, parent);
}

/** /docs/<slug>: an article, a tab or a collection (one name each), or where one went since. */
export default async function DocsSlugPage(props: PageProps<"/portal/[project]/docs/[slug]">) {
  const at = await portalLinks();
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  if (!page) {
    notFound();
  }
  if (page.kind === "redirect") {
    permanentRedirect(at(page.path));
  }
  switch (page.kind) {
    case "tab":
      return <DocsTabPage project={project} docs={page.docs} tab={page.tab} landing={page.landing} />;
    case "collection":
      return <DocsCollectionPage page={page} />;
    case "article":
    case "locked":
      return <DocsArticle project={project} slug={slug} article={page.article} />;
  }
}
