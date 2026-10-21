import { portalAddress } from "@/server/custom-domains";
import { articleMarkdown, publishedArticle } from "@/server/help-queries";

/** A published article as Markdown, at /help/<slug>.md (proxy.ts sends it here), for AI tools. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/docs/[slug]/md">) {
  const { project, slug } = await params;
  const article = await publishedArticle(project, slug);
  if (!article) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(articleMarkdown(article), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Never from a shared cache: its collection may become for some reader groups only at any time, and a
      // copy kept from before would reach people that excludes. A restricted one isn't kept at all.
      "cache-control": article.restricted ? "private, no-store" : "private, max-age=300",
      // Search engines index the article's page, not this copy of it.
      link: `<${await portalAddress(project)}/docs/${slug}>; rel="canonical"`,
      // Unlisted: for people with the link, not search engines.
      ...(article.listing === "UNLISTED" && { "x-robots-tag": "noindex" }),
    },
  });
}
