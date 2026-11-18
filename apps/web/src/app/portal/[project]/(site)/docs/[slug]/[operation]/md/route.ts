import { operationMarkdown } from "@tuti/shared/api-reference";

import { apiReferencePage } from "@/server/api-reference-queries";
import { portalAddress } from "@/server/custom-domains";

/**
 * An API reference's operation as Markdown, at /docs/<reference>/<operation>.md (proxy.ts sends it here), for AI tools:
 * for whoever may read its page (apiReferencePage), and a 404 wherever the page is one or shows it locked.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/docs/[slug]/[operation]/md">) {
  const { project, slug, operation: operationSlug } = await params;
  const page = await apiReferencePage(project, slug);
  const operation = page?.kind === "reference" ? page.operations.find((o) => o.slug === operationSlug) : undefined;
  if (page?.kind !== "reference" || !operation) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  return new Response(operationMarkdown(page.doc, operation, { base: page.reference.baseUrl ?? undefined }), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // As an article's .md: never from a shared cache (its tab may become for some readers only), a restricted one not kept at all.
      "cache-control": page.restricted ? "private, no-store" : "private, max-age=300",
      // Search engines index its page, not this copy of it.
      link: `<${await portalAddress(project)}/docs/${slug}/${operationSlug}>; rel="canonical"`,
    },
  });
}
