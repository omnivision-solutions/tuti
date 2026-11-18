import type { Metadata } from "next";
import { OPENAPI_MAX_BYTES } from "@tuti/shared/api-reference";
import { BracesIcon } from "lucide-react";

import { ApiReferenceEndpoints, ApiReferenceMore, ApiReferenceSync, ApiReferenceTabs } from "@/components/api-reference-endpoints";
import { ArticleStateBadge } from "@/components/docs-article-rows";
import { DocsPageHeader } from "@/components/docs-page-header";
import { portalAddress } from "@/server/custom-domains";

import { loadReference } from "./load";

export const metadata: Metadata = { title: "API reference · Docs" };

/**
 * An API reference's page in the app: Endpoints, its groups and operations with a switch each for the help center.
 * Its Settings are its other tab (settings/page.tsx).
 */
export default async function ApiReferencePage(props: PageProps<"/app/[project]/docs/references/[reference]">) {
  const { project: slug, reference: referenceSlug } = await props.params;
  const reference = await loadReference(slug, referenceSlug);
  const portal = await portalAddress(slug);

  return (
    <>
      <DocsPageHeader
        back={{ href: `/app/${slug}/docs`, label: "Docs" }}
        title={reference.name}
        icon={<BracesIcon />}
        // Published, with something on the help center: a reference with every operation off has no page there.
        helpCenter={reference.published && reference.counts.onHelpCenter > 0 ? `${portal}/docs/${reference.slug}` : undefined}
        actions={<ApiReferenceSync projectSlug={slug} slug={reference.slug} source={reference.source} maxBytes={OPENAPI_MAX_BYTES} />}
        more={<ApiReferenceMore projectSlug={slug} slug={reference.slug} name={reference.name} published={reference.published} />}
        filters={<ApiReferenceTabs projectSlug={slug} slug={reference.slug} endpoints={reference.counts.operations} />}
      />
      <ApiReferenceEndpoints
        // Another reference's page is another list: nothing of this one's New or unsaved switches carries over.
        key={reference.slug}
        projectSlug={slug}
        slug={reference.slug}
        state={<ArticleStateBadge state={reference.published ? "published" : "draft"} />}
        published={reference.published}
        groups={reference.groups.map(({ key, name, description, onHelpCenter }) => ({ key, name, description, onHelpCenter }))}
        operations={reference.operations.map(({ key, slug: operation, title, kind, path, group, alsoIn, deprecated, hidden, new: isNew }) => ({ key, slug: operation, title, kind, path, group, alsoIn, deprecated, hidden, new: isNew }))}
        unreadable={reference.warnings.reduce((sum, warning) => sum + warning.count, 0)}
      />
    </>
  );
}
