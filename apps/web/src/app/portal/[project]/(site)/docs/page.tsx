import type { Metadata } from "next";

import { referenceListing } from "@/components/portal-api-operation";
import { DocsLayout, docsPageListing, DocsSearchResults, DocsTabPage } from "@/components/portal-docs";
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
  // In the page's language: "Documentation", the search's title, the default subtitle.
  const [header, helpCenter] = await Promise.all([pageTranslator("header"), pageTranslator("helpCenter")]);
  const docs = header.t("docs");
  if (query) {
    return portalPageMetadata(project, { title: `${helpCenter.t("resultsFor", { q: query })} · ${docs}`, path: "/docs", noindex: true });
  }
  const { tab, landing } = await docsHome(project);
  if (tab?.locked) {
    return portalPageMetadata(project, { title: docs, path: "/docs", noindex: true });
  }
  if (landing.kind === "reference") {
    return portalPageMetadata(project, { ...((await referenceListing(project, landing.slug)) ?? { title: landing.name }), path: "/docs" });
  }
  if (landing.kind !== "overview") {
    // An article in its place: in each language it's translated into, here (docs/plan.md, "A page not yet translated").
    return portalPageMetadata(project, { ...docsPageListing(landing, docs), path: "/docs", ...(landing.kind === "article" && { addresses: await landingAddresses(project, landing.slug, "/docs") }) });
  }
  const home = (await portalSite(project))?.brand.docsHome;
  return portalPageMetadata(project, { title: docs, description: home?.subtitle || helpCenter.t("headingSubtitle"), path: "/docs" });
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
      <DocsLayout tree={docsTree(docs, tab?.slug ?? null, null)} current={null}>
        <DocsSearchResults projectSlug={slug} query={query} />
      </DocsLayout>
    );
  }
  return <DocsTabPage project={slug} docs={docs} tab={tab} landing={landing} path="/docs" />;
}
