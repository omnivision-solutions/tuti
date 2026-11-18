import { DocsTabsRow } from "@/components/portal-docs";
import { apiReferencePage } from "@/server/api-reference-queries";
import { docsContents, docsPage } from "@/server/docs-queries";

/** The tab a tab's page, collection, article or API reference is in (the page reads the same docsPage and apiReferencePage, once per request). */
export default async function DocsPageTabs(props: PageProps<"/portal/[project]/docs/[slug]">) {
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  switch (page?.kind) {
    case "tab":
      return <DocsTabsRow docs={page.docs} active={page.tab.slug} />;
    case "collection":
      return <DocsTabsRow docs={page.docs} active={page.tab?.slug ?? null} />;
    case "article":
    case "locked": {
      const docs = await docsContents(project);
      return <DocsTabsRow docs={docs} active={page.article.tab ?? docs.home} />;
    }
    case "redirect":
      return null;
    default: {
      const reference = await apiReferencePage(project, slug);
      if (!reference) {
        return null;
      }
      const docs = await docsContents(project);
      return <DocsTabsRow docs={docs} active={reference.tab ?? docs.home} />;
    }
  }
}
