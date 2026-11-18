import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ApiOperationPage, LockedOperation } from "@/components/portal-api-operation";
import { apiReferencePage } from "@/server/api-reference-queries";
import { portalPageMetadata } from "@/server/portal-metadata";

/** The operation `operation` of reference `slug`, when this reader may see it (apiReferencePage); a locked one, by its title alone. */
async function operationPage(props: PageProps<"/portal/[project]/docs/[slug]/[operation]">) {
  const { project, slug, operation: operationSlug } = await props.params;
  const page = await apiReferencePage(project, slug);
  const path = `/docs/${slug}/${operationSlug}`;
  if (page?.kind === "locked") {
    const title = page.operations.find((o) => o.slug === operationSlug)?.title;
    return title === undefined ? null : { kind: "locked" as const, project, page, title, path };
  }
  const operation = page?.operations.find((o) => o.slug === operationSlug);
  return page && operation ? { kind: "operation" as const, project, page, operation, title: operation.title, path } : null;
}

/** "<operation> · <reference>"; one for some readers only, or locked for this one, isn't for search engines. */
export async function generateMetadata(props: PageProps<"/portal/[project]/docs/[slug]/[operation]">): Promise<Metadata> {
  const found = await operationPage(props);
  if (!found) {
    return {};
  }
  const { project, page, title, path } = found;
  return portalPageMetadata(project, { title: `${title} · ${page.reference.name}`, path, noindex: found.kind === "locked" || found.page.restricted });
}

/** /docs/<reference>/<operation>: an API reference's operation. A hidden one, an unpublished reference or an unknown slug is a 404. */
export default async function DocsOperationPage(props: PageProps<"/portal/[project]/docs/[slug]/[operation]">) {
  const found = await operationPage(props);
  if (!found) {
    notFound();
  }
  return found.kind === "locked" ? (
    <LockedOperation page={found.page} title={found.title} />
  ) : (
    <ApiOperationPage project={found.project} page={found.page} operation={found.operation} />
  );
}
