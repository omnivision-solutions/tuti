import { portalUrl } from "@/lib/hosts";
import { articleMarkdown, publishedArticle } from "@/server/help-queries";

/** A published article as Markdown, at /help/<slug>.md (proxy.ts sends it here), for AI tools. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/help/[slug]/md">) {
  const { project, slug } = await params;
  const article = await publishedArticle(project, slug);
  if (!article) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(articleMarkdown(article), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
      // Search engines index the article's page, not this copy of it.
      link: `<${portalUrl(project)}/help/${slug}>; rel="canonical"`,
    },
  });
}
