import type { Metadata } from "next";

import { referenceListing } from "@/components/portal-api-operation";
import { DocsLayout, docsPageListing, DocsSearchResults, DocsTabPage } from "@/components/portal-docs";
import { DOCS_HEADING } from "@/lib/portal-look";
import { docsHome, docsTree, landingAddresses } from "@/server/docs-queries";
import { portalPageMetadata, portalSite } from "@/server/portal-metadata";
import { pageTranslator } from "@/server/portal-language";

const searchQuery = (q: string | string[] | undefined) => (typeof q === "string" ? q.trim().slice(0, 200) : "");

/**
 * One address for search engines: /docs (showing an article or collection, that one's title and
 * description); its search results aren't for them.
 */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs">): Promise<Metadata> {
  const [{ project }, { q }] = await Promise.all([props.params, props.searchParams]);
  const query = searchQuery(q);
  if (query) {
    return portalPageMetadata(project, { title: `Results for “${query}” · Documentation`, path: "/docs", noindex: true });
  }
  const { tab, landing } = await docsHome(project);
  if (tab?.locked) {
    return portalPageMetadata(project, { title: "Documentation", path: "/docs", noindex: true });
  }
  if (landing.kind === "reference") {
    return portalPageMetadata(project, { ...((await referenceListing(project, landing.slug)) ?? { title: landing.name }), path: "/docs" });
  }
  if (landing.kind !== "overview") {
    // An article in its place: in each language it's translated into, here (docs/plan.md, "A page not yet translated").
    return portalPageMetadata(project, { ...docsPageListing(landing), path: "/docs", ...(landing.kind === "article" && { addresses: await landingAddresses(project, landing.slug, "/docs") }) });
  }
  const home = (await portalSite(project))?.brand.docsHome;
  return portalPageMetadata(project, { title: "Documentation", description: home?.subtitle || DOCS_HEADING.subtitle, path: "/docs" });
}

/**
 * The docs: the first tab (the others are at /docs/<tab>; its overview, or the page it shows), or
 * everything without tabs; `?q=` searches all of it.
 */
export default async function DocsPage(props: PageProps<"/portal/[project]/docs">) {
  const [{ project: slug }, { q }] = await Promise.all([props.params, props.searchParams]);
  const query = searchQuery(q);
  const { docs, tab, landing } = await docsHome(slug);
  if (query) {
    return (
      <DocsLayout tree={docsTree(docs, tab?.slug ?? null, null)} current={null} browse={(await pageTranslator("helpCenter")).t("browseDocs")}>
        <DocsSearchResults projectSlug={slug} query={query} />
      </DocsLayout>
    );
  }
  return <DocsTabPage project={slug} docs={docs} tab={tab} landing={landing} path="/docs" />;
}
