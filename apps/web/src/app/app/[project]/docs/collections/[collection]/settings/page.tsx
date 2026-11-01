import { prisma } from "@tuti/db";
import { notFound, redirect } from "next/navigation";

import { AccessForm, CollectionSettingsForm } from "@/components/docs";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ancestry, height, MAX_COLLECTION_DEPTH } from "@/lib/collection-tree";
import { fromNoAccess, fromReadAccess } from "@/lib/read-access";
import { claimsOf } from "@/lib/reader-groups";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { teamDocs } from "@/server/team-docs";

/** A collection's settings, on one page: its name, icon, description and place, then who can read it. */
export default async function CollectionSettingsPage(props: PageProps<"/app/[project]/docs/collections/[collection]/settings">) {
  const { project: slug, collection: collectionSlug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [docs, access] = await Promise.all([teamDocs(projectId), accessChoices(projectId)]);
  const collection = docs.collections.find((c) => c.slug === collectionSlug);
  if (!collection) {
    // Renamed (here too, after saving its name): its settings now. Deleted: the docs.
    const renamed = await prisma.docsRedirect.findFirst({ where: { projectId, slug: collectionSlug }, select: { collection: { select: { slug: true } } } });
    redirect(renamed?.collection ? `/app/${slug}/docs/collections/${renamed.collection.slug}/settings` : `/app/${slug}/docs`);
  }
  // Where it can go: not in itself or one inside it, and no deeper than collections go with the ones in it.
  const levels = height(docs.collections, collection.id);
  const parents = docs.collections
    .filter((c) => c.depth + levels <= MAX_COLLECTION_DEPTH && !ancestry(docs.collections, c.id).some((up) => up.id === collection.id))
    .map((c) => ({ slug: c.slug, name: docs.pathOf(c.id) }));

  return (
    <>
      <PageHeader back={{ href: `/app/${slug}/docs/collections/${collection.slug}`, label: collection.name }} title="Collection settings" />
      <Card role="region" aria-labelledby="collection-details-title">
        <CardHeader>
          <CardTitle id="collection-details-title">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <CollectionSettingsForm
            projectSlug={slug}
            collection={{
              slug: collection.slug,
              name: collection.name,
              description: collection.description,
              parent: collection.parent,
              icon: collection.icon,
              knownIcon: collection.knownIcon,
            }}
            parents={parents}
          />
        </CardContent>
      </Card>
      <Card role="region" aria-labelledby="collection-access-title">
        <CardHeader>
          <CardTitle id="collection-access-title">Access</CardTitle>
        </CardHeader>
        <CardContent>
          <AccessForm
            projectSlug={slug}
            kind="collection"
            slug={collection.slug}
            path={`/docs/${collection.slug}`}
            access={access}
            above={collection.parent ?? collection.tab ?? ""}
            level={{ access: fromReadAccess(collection.access), groups: claimsOf(collection), noAccess: fromNoAccess(collection.noAccess) }}
          />
        </CardContent>
      </Card>
    </>
  );
}
