import type { Metadata } from "next";
import { OPENAPI_MAX_BYTES } from "@tuti/shared/api-reference";
import { BracesIcon } from "lucide-react";
import { notFound, redirect } from "next/navigation";

import { ApiReferenceEndpoints, ApiReferenceMore, ApiReferenceSync } from "@/components/api-reference-endpoints";
import { ArticleStateBadge } from "@/components/docs-article-rows";
import { DocsPageHeader } from "@/components/docs-page-header";
import { portalAddress } from "@/server/custom-domains";
import { getMembership } from "@/server/membership";
import { OperationError } from "@/server/operations";
import { getApiReference } from "@/server/operations/api-references";
import { call } from "@/server/operations/run";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "API reference · Docs" };

/**
 * An API reference's page in the app: Endpoints, its groups and operations with a switch each for the help center.
 * Its Settings are its other tab, once they're built (docs/plan.md, A9): until then there's no row of tabs for one.
 */
export default async function ApiReferencePage(props: PageProps<"/app/[project]/docs/references/[reference]">) {
  const { project: slug, reference: referenceSlug } = await props.params;
  const [session, membership] = await Promise.all([getSession(), getMembership(slug)]);
  if (!session || !membership) {
    notFound();
  }
  const reference = await call(getApiReference, { actor: { kind: "user", userId: session.user.id }, projectId: membership.project.id }, { slug: referenceSlug }).catch((error: unknown) => {
    if (error instanceof OperationError) {
      // Deleted (here too, under More), or its address changed: the docs.
      redirect(`/app/${slug}/docs`);
    }
    throw error;
  });
  const portal = await portalAddress(slug);

  return (
    <>
      <DocsPageHeader
        back={{ href: `/app/${slug}/docs`, label: "Docs" }}
        title={reference.name}
        icon={<BracesIcon />}
        helpCenter={reference.published ? `${portal}/docs/${reference.slug}` : undefined}
        actions={<ApiReferenceSync projectSlug={slug} slug={reference.slug} source={reference.source} maxBytes={OPENAPI_MAX_BYTES} />}
        more={<ApiReferenceMore projectSlug={slug} slug={reference.slug} name={reference.name} published={reference.published} />}
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
