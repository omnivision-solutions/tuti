import { toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";

import { portalAddress } from "@/server/custom-domains";
import { displayDoc } from "@/server/content";
import { SIGNED_OUT } from "@/lib/read-access";
import { articleMarkdown, docsContents, everyCollection, listedArticle } from "@/server/docs-queries";

/**
 * Every docs article llms.txt links, in its order, with its full text (llmstxt.org's llms-full.txt): the project's
 * name, then each article's Markdown, its title with a line saying where it's from.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/llms-full.txt">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { name: true } });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  const portal = await portalAddress(slug);
  // What llms.txt lists: for everyone, and not what the team kept from search engines.
  const docs = await docsContents(slug, { reader: SIGNED_OUT, indexable: true, locks: false });
  const parts = docs.tabs.length > 0 ? docs.tabs : [docs];
  const slugs = parts.flatMap((part) => [...everyCollection(part.collections).flatMap((c) => c.articles), ...part.uncollected]).map((a) => a.slug);
  // ponytail: every article's text in one response; page it (or cap it) if docs ever get big enough to matter.
  const rows = await prisma.article.findMany({
    where: { ...listedArticle, project: { slug }, slug: { in: slugs } },
    select: { slug: true, title: true, body: true, content: true },
  });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const articles = await Promise.all(
    slugs.flatMap((articleSlug) => {
      const row = bySlug.get(articleSlug);
      if (!row) {
        return [];
      }
      // Its title, then where it's from, then what it says.
      return articleMarkdown({ title: row.title, doc: displayDoc(row) }).then((markdown) =>
        markdown.replace("\n", `\nSource: ${portal}/docs/${articleSlug}\n`),
      );
    }),
  );
  const title = toMarkdown({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: project.name }] }] });
  return new Response([`${title}\n`, ...articles].join("\n"), {
    // Never from a shared cache, like each article's .md: any of them may become for some readers only at any time.
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=300" },
  });
}
