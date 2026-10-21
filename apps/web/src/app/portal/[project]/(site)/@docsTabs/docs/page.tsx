import { DocsTabsRow } from "@/components/portal-docs";
import { docsContents } from "@/server/docs-queries";

/** /docs is the first tab (or the first with something to read); its search results are in none. */
export default async function DocsHomeTabs(props: PageProps<"/portal/[project]/docs">) {
  const [{ project }, { q }] = await Promise.all([props.params, props.searchParams]);
  const docs = await docsContents(project);
  const tab = typeof q === "string" && q.trim() ? null : (docs.tabs.find((t) => t.slug === docs.home) ?? docs.tabs[0] ?? null);
  return <DocsTabsRow docs={docs} active={tab?.slug ?? null} />;
}
