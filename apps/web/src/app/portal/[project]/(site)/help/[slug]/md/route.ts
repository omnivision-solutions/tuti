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
      // One for some reader groups only must never be served from a shared cache to someone else.
      "cache-control": article.restricted ? "private, no-store" : "public, max-age=300",
      // Search engines index the article's page, not this copy of it.
      link: `<${portalUrl(project)}/help/${slug}>; rel="canonical"`,
      // Unlisted: for people with the link, not search engines.
      ...(article.listing === "UNLISTED" && { "x-robots-tag": "noindex" }),
    },
  });
}
