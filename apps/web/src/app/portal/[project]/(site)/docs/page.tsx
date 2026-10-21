import type { Metadata } from "next";

import { DocsIndex, DocsLayout } from "@/components/portal-docs";
import { portalAddress } from "@/server/custom-domains";
import { docsContents, docsTree } from "@/server/docs-queries";

const searchQuery = (q: string | string[] | undefined) => (typeof q === "string" ? q.trim().slice(0, 200) : "");

/** One address for search engines: /docs; its search results aren't for them. */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs">): Promise<Metadata> {
  const [{ project }, { q }] = await Promise.all([props.params, props.searchParams]);
  return {
    title: "Docs",
    alternates: { canonical: `${await portalAddress(project)}/docs` },
    ...(searchQuery(q) && { robots: { index: false } }),
  };
}

/** The docs: the first tab (the others are at /docs/<tab>), or everything without tabs; `?q=` searches all of it. */
export default async function DocsPage(props: PageProps<"/portal/[project]/docs">) {
  const [{ project: slug }, { q }] = await Promise.all([props.params, props.searchParams]);
  const query = searchQuery(q);
  const docs = await docsContents(slug);
  // The first tab, or the first with something to read for this reader.
  const tab = docs.tabs.find((t) => t.slug === docs.home) ?? docs.tabs[0] ?? null;
  return (
    <DocsLayout tree={docsTree(docs, tab?.slug ?? null, null)} current={null}>
      <DocsIndex projectSlug={slug} query={query} docs={docs} tab={tab} />
    </DocsLayout>
  );
}
