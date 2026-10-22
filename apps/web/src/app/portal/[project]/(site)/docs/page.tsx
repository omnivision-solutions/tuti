import type { Metadata, ResolvingMetadata } from "next";

import { DocsLayout, docsPageMetadata, DocsSearchResults, DocsTabPage, withPortalOpenGraph } from "@/components/portal-docs";
import { portalAddress } from "@/server/custom-domains";
import { docsHome, docsTree } from "@/server/docs-queries";

const searchQuery = (q: string | string[] | undefined) => (typeof q === "string" ? q.trim().slice(0, 200) : "");

/**
 * One address for search engines: /docs (showing an article or collection, that one's title and
 * description); its search results aren't for them.
 */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs">, parent?: ResolvingMetadata): Promise<Metadata> {
  const [{ project }, { q }] = await Promise.all([props.params, props.searchParams]);
  const canonical = { alternates: { canonical: `${await portalAddress(project)}/docs` } };
  if (searchQuery(q)) {
    return { title: "Docs", ...canonical, robots: { index: false } };
  }
  const { tab, landing } = await docsHome(project);
  if (tab?.locked) {
    return { title: "Docs", ...canonical, robots: { index: false } };
  }
  return withPortalOpenGraph({ ...(landing.kind === "overview" ? { title: "Docs" } : docsPageMetadata(landing)), ...canonical }, parent);
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
  return <DocsTabPage project={slug} docs={docs} tab={tab} landing={landing} />;
}
