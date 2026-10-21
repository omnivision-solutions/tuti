import { DocsTabsRow } from "@/components/portal-docs";
import { docsContents, docsPage } from "@/server/docs-queries";

/** The tab a tab's page, collection or article is in (the page reads the same docsPage, once per request). */
export default async function DocsPageTabs(props: PageProps<"/portal/[project]/docs/[slug]">) {
  const { project, slug } = await props.params;
  const page = await docsPage(project, slug);
  switch (page?.kind) {
    case "tab":
      return <DocsTabsRow docs={page.docs} active={page.tab.slug} />;
    case "collection":
      return <DocsTabsRow docs={page.docs} active={page.tab?.slug ?? null} />;
    case "article": {
      const docs = await docsContents(project);
      return <DocsTabsRow docs={docs} active={page.article.tab ?? docs.home} />;
    }
    default:
      return null;
  }
}
