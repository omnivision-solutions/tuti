import type { Metadata } from "next";
import { OPENAPI_MAX_BYTES } from "@tuti/shared/api-reference";
import { BracesIcon } from "lucide-react";

import { ApiReferenceTabs } from "@/components/api-reference-endpoints";
import { ApiReferenceSettings } from "@/components/api-reference-settings";
import { DocsPageHeader } from "@/components/docs-page-header";
import { timeAgo } from "@/lib/format";
import { portalAddress } from "@/server/custom-domains";

import { loadReference, loadRepositories } from "../load";

export const metadata: Metadata = { title: "API reference settings · Docs" };

/** An API reference's Settings (docs/plan.md, A9): its name and address, where it's read from, what couldn't be read, and how it shows on the help center. */
export default async function ApiReferenceSettingsPage(props: PageProps<"/app/[project]/docs/references/[reference]/settings">) {
  const { project: slug, reference: referenceSlug } = await props.params;
  const reference = await loadReference(slug, referenceSlug);
  const portal = await portalAddress(slug);
  const repositories = reference.source === "github" ? await loadRepositories(slug) : [];
  const github = reference.source === "github" && reference.repoId !== null ? { repoId: reference.repoId, path: reference.path ?? "", ref: reference.ref ?? "" } : undefined;
  // Read from somewhere: tried every 6 hours (and a repository's on a merge), so when it last was, and when one last worked.
  const synced = reference.source !== "upload";
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
          github,
          repositories,
          rows: [
            ["From", reference.source === "upload" ? "Uploaded file" : reference.source === "url" ? "A URL" : "GitHub"],
            ...(github
              ? ([
                  ["Repository", repositories.find((repo) => repo.id === github.repoId)?.fullName ?? "A repository the project removed"],
                  ["File", github.path],
                  ["Branch", github.ref],
                ] as [string, string][])
              : []),
            ["Format", reference.version ? `${format} · version ${reference.version}` : format],
            ...(synced ? ([["Last tried", timeAgo(reference.syncTriedAt)]] as [string, string][]) : []),
            [synced ? "Last synced" : "Last read", timeAgo(reference.syncedAt)],
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
