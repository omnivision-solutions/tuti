import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { DocsWorkspace } from "@/components/docs-tree";
import { portalAddress } from "@/server/custom-domains";
import { accessChoices } from "@/server/docs-queries";
import { getMembership, isAdminRole } from "@/server/membership";
import { restorableSince } from "@/server/operations/docs";
import { newCollectionParents, teamDocs, treeArticle } from "@/server/team-docs";

/** Every Docs page in the app: the docs as a tree beside it (see DocsWorkspace). */
export default async function TeamDocsLayout({ children, params }: LayoutProps<"/app/[project]/docs">) {
  const { project: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [docs, access, deleted, portal] = await Promise.all([
    teamDocs(projectId),
    accessChoices(projectId),
    prisma.article.count({ where: { projectId, deletedAt: { gte: restorableSince() } } }),
    portalAddress(slug),
  ]);
  return (
    <DocsWorkspace
      projectSlug={slug}
      tabs={docs.tabs.map((tab) => ({ slug: tab.slug, name: tab.name }))}
      collections={docs.collections.map((c) => ({
        slug: c.slug,
        name: c.name,
        parent: c.parent,
        tab: c.tab,
        icon: c.knownIcon ? c.icon : null,
        articles: c.articles.map(treeArticle),
      }))}
      uncollected={docs.uncollected.map(treeArticle)}
      access={access}
      parents={newCollectionParents(docs)}
      portal={`${portal}/docs`}
      admin={isAdminRole(membership.role)}
      deleted={deleted}
    >
      {children}
    </DocsWorkspace>
  );
}
