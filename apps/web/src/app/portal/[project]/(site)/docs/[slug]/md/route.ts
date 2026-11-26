import { portalAddress } from "@/server/custom-domains";
import { articleMarkdown, articleNamed, movedArticle, publishedArticle } from "@/server/docs-queries";
import { pageLanguages } from "@/server/language-addresses";
import { portalHref, portalLanguage } from "@/server/portal-base";

/** A published article as Markdown, at /docs/<slug>.md (proxy.ts sends it here), for AI tools. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/docs/[slug]/md">) {
  const { project, slug: asked } = await params;
  // At a language's address, by its slug there: another of its slugs goes to that one, as its page does.
  const named = await articleNamed(project, asked);
  if (named && named.own !== asked) {
    return new Response(null, { status: 308, headers: { location: await portalHref(`/docs/${named.own}.md`), "cache-control": "private, no-store" } });
  }
  const slug = named?.slug ?? asked;
  const [article, { prefix, language }, languages] = await Promise.all([publishedArticle(project, slug), portalLanguage(), pageLanguages(project)]);
  // Its own address only in a live language: the team's preview of another is canonical to the default's, as its page is.
  const translated = !!prefix && !!article && !article.untranslated && !!language && !!languages?.live.includes(language);
  if (!article) {
    // An old slug of an article that has since moved: to its current .md.
    const moved = await movedArticle(project, slug);
    if (moved) {
      // Not kept by any cache: the article may become restricted, or a page may take the old slug.
      const headers = { location: await portalHref(`/docs/${moved}.md`), "cache-control": "private, no-store" };
      return new Response(null, { status: 308, headers });
    }
    return new Response("Not found", { status: 404 });
  }
  return new Response(await articleMarkdown(article), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Never from a shared cache: it (or its collection or tab) may become for some readers only at any time, and a
      // copy kept from before would reach people that excludes. A restricted one isn't kept at all.
      "cache-control": article.restricted ? "private, no-store" : "private, max-age=300",
      // Search engines index the article's page, not this copy of it: its translation's at its address there, else the
      // default language's (docs/plan.md, "A page not yet translated").
      link: `<${await portalAddress(project)}${translated ? `${prefix}/docs/${asked}` : `/docs/${slug}`}>; rel="canonical"`,
      // Unlisted: for people with the link, not search engines; nor one whose team blocked search indexing, nor sample content.
      ...((article.listing === "UNLISTED" || article.noindex || article.sample) && { "x-robots-tag": "noindex" }),
    },
  });
}
