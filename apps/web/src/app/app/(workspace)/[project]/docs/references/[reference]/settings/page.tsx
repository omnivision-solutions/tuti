import type { Metadata } from "next";
import { OPENAPI_MAX_BYTES } from "@tuti/shared/api-reference";
import { BracesIcon } from "lucide-react";

import { ApiReferenceTabs } from "@/components/api-reference-endpoints";
import { ApiReferenceSettings } from "@/components/api-reference-settings";
import { DocsPageHeader } from "@/components/docs-page-header";
import { timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";

import { loadReference } from "../load";

export const metadata: Metadata = { title: "API reference settings · Docs" };

/** An API reference's Settings (docs/plan.md, A9): its name and address, where it's read from, what couldn't be read, and how it shows on the help center. */
export default async function ApiReferenceSettingsPage(props: PageProps<"/app/[project]/docs/references/[reference]/settings">) {
  const { project: slug, reference: referenceSlug } = await props.params;
  const reference = await loadReference(slug, referenceSlug);
  const portal = await portalAddress(slug);
  const format = reference.format === "graphql" ? "GraphQL" : "OpenAPI";

  return (
    <>
      <DocsPageHeader
        back={{ href: `/app/${slug}/docs`, label: "Docs" }}
        title={reference.name}
        icon={<BracesIcon />}
        // Its form's Save, Cancel and unsaved changes (ApiReferenceSettings).
        actions={<div id="api-reference-actions" className="flex items-center gap-2" />}
        filters={<ApiReferenceTabs projectSlug={slug} slug={reference.slug} endpoints={reference.counts.operations} />}
      />
      <ApiReferenceSettings
        // A new address is another page: nothing typed here carries over.
        key={reference.slug}
        projectSlug={slug}
        host={portal.replace(/^https?:\/\//, "")}
        reference={{ slug: reference.slug, name: reference.name, baseUrl: reference.baseUrl, treeStyle: reference.treeStyle, tryIt: reference.tryIt }}
        source={{
          kind: reference.source,
          url: reference.sourceUrl,
          rows: [
            ["From", reference.source === "upload" ? "Uploaded file" : reference.source === "url" ? "A URL" : reference.source],
            ["Format", reference.version ? `${format} · version ${reference.version}` : format],
            // A URL's sync is tried every 6 hours: when it last was, and when one last worked.
            ...(reference.source === "url" ? ([["Last tried", timeAgo(reference.syncTriedAt)]] as [string, string][]) : []),
            [reference.source === "url" ? "Last synced" : "Last read", timeAgo(reference.syncedAt)],
            ["Last changed", timeAgo(reference.changedAt)],
            ...(reference.syncError ? ([["Last sync failed", reference.syncError]] as [string, string][]) : []),
          ],
        }}
        groups={reference.groups.map((group) => ({ key: group.key, name: group.name, endpoints: reference.operations.filter((operation) => operation.group === group.key).length }))}
        warnings={reference.warnings}
        maxBytes={OPENAPI_MAX_BYTES}
      />
    </>
  );
}
