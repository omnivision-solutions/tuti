import { DocsTabsRow } from "@/components/portal-docs";
import { apiReferencePage } from "@/server/api-reference-queries";
import { docsContents } from "@/server/docs-queries";

/** The tab an API reference's operation is in (the page reads the same apiReferencePage, once per request). */
export default async function DocsOperationTabs(props: PageProps<"/portal/[project]/docs/[slug]/[operation]">) {
  const { project, slug } = await props.params;
  const page = await apiReferencePage(project, slug);
  if (!page) {
    return null;
  }
  const docs = await docsContents(project);
  return <DocsTabsRow docs={docs} active={page.tab ?? docs.home} />;
}
