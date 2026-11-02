import { DocsTabsRow } from "@/components/portal-docs";
import { docsContents } from "@/server/docs-queries";

/** /docs is the first tab (or the first with something to read); its search results too, as the tree beside them is its. */
export default async function DocsHomeTabs(props: PageProps<"/portal/[project]/docs">) {
  const { project } = await props.params;
  const docs = await docsContents(project);
  const tab = docs.tabs.find((t) => t.slug === docs.home) ?? docs.tabs[0] ?? null;
  return <DocsTabsRow docs={docs} active={tab?.slug ?? null} />;
}
