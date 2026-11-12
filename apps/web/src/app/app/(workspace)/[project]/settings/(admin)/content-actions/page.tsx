import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { ContentActionsSettings } from "@/components/docs-look-settings";
import { portalPreview } from "@/server/customize";
import { listedArticle } from "@/server/docs-queries";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

/** Settings → Portal → Content actions: what readers can do with an article, beside one of the docs' articles. */
export default async function ContentActionsPage(props: PageProps<"/app/[project]/settings/content-actions">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [brand, article] = await Promise.all([
    branding({ id: project.id }),
    prisma.article.findFirst({ where: { ...listedArticle, projectId: project.id }, orderBy: [{ order: "asc" }, { title: "asc" }], select: { slug: true } }),
  ]);
  return (
    <PortalSettingsPane
      page="content-actions"
      preview={await portalPreview(slug, article ? `/docs/${article.slug}` : "/docs")}
    >
      <ContentActionsSettings projectSlug={slug} actions={brand!.contentActions} />
    </PortalSettingsPane>
  );
}
