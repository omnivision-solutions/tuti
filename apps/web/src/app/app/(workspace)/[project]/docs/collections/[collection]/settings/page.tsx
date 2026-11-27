import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { aiEnabled, isLanguage, LANGUAGES } from "@tuti/shared";
import { notFound, redirect } from "next/navigation";

import { CollectionSettingsForm, DeleteCollectionButton } from "@/components/docs";
import { LabelTranslations } from "@/components/label-translations";
import { CollectionHeader } from "@/components/docs-article-rows";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { ancestry, height, MAX_COLLECTION_DEPTH } from "@/lib/collection-tree";
import { fromNoAccess, fromReadAccess } from "@/lib/read-access";
import { claimsOf } from "@/lib/reader-groups";
import { accessChoices } from "@/server/docs-queries";
import { getMembership } from "@/server/membership";
import { collectionTranslations } from "@/server/operations/label-translations";
import { teamDocs } from "@/server/team-docs";

export const metadata: Metadata = { title: "Collection settings · Docs" };

/** A collection's settings, on one page: its name, icon, description and place, then who can read it, with one Save. */
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
  // Its name and description in the project's other languages (none: no Translations).
  const translations = (await collectionTranslations(projectId, collection.slug)).flatMap((row) => (isLanguage(row.language) ? [{ ...row, native: LANGUAGES[row.language].native }] : []));
  const [{ language: defaultLanguage }, { sample }] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { language: true } }),
    prisma.collection.findUniqueOrThrow({ where: { id: collection.id }, select: { sample: true } }),
  ]);
  // Where it can go: not in itself or one inside it, and no deeper than collections go with the ones in it.
  const levels = height(docs.collections, collection.id);
  const parents = docs.collections
    .filter((c) => c.depth + levels <= MAX_COLLECTION_DEPTH && !ancestry(docs.collections, c.id).some((up) => up.id === collection.id))
    .map((c) => ({ slug: c.slug, name: docs.pathOf(c.id) }));

  return (
    <>
      <CollectionHeader
        projectSlug={slug}
        collection={{ slug: collection.slug, name: collection.name, description: collection.description, icon: collection.icon, knownIcon: collection.knownIcon }}
        hasChildren={docs.collections.some((c) => c.parentId === collection.id)}
        settings
      />
      {/* Settings' cards and rows (docs/design.md → Settings rows), in one centred column. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
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
          access={access}
          path={`/docs/${collection.slug}`}
          tab={collection.tab}
          tabName={docs.tabs.find((t) => t.slug === collection.tab)?.name ?? null}
          backHref={`/app/${slug}/docs/collections/${collection.slug}`}
          level={{ access: fromReadAccess(collection.access), groups: claimsOf(collection), noAccess: fromNoAccess(collection.noAccess) }}
        />
        {translations.length > 0 && (
          <LabelTranslations
            kind="collection"
            projectSlug={slug}
            slug={collection.slug}
            defaultName={isLanguage(defaultLanguage) ? LANGUAGES[defaultLanguage].name : defaultLanguage}
            translations={translations}
            // Sample content is never translated: only the team's own there.
            ai={aiEnabled() && !sample}
          />
        )}
        <SettingsCard>
          <SettingRow inline label={<span className="text-destructive-foreground">Delete collection</span>} description="Its articles stay, without a collection.">
            <DeleteCollectionButton standalone projectSlug={slug} slug={collection.slug} name={collection.name} hasChildren={docs.collections.some((c) => c.parentId === collection.id)} />
          </SettingRow>
        </SettingsCard>
      </div>
    </>
  );
}
