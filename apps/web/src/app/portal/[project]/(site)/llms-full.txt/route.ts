import { toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";
import { operationMarkdown } from "@tuti/shared/api-reference";

import { portalAddress } from "@/server/custom-domains";
import { displayDoc } from "@/server/content";
import { SIGNED_OUT } from "@/lib/read-access";
import { shownOperations } from "@/server/api-reference-queries";
import { articleMarkdown, currentVersions, docsContents, everyCollection, listedArticle, type ShownVersion } from "@/server/docs-queries";
import { portalLanguage } from "@/server/portal-base";

/**
 * Every docs article and API operation llms.txt links, in its order, with its full text (llmstxt.org's llms-full.txt):
 * the project's name, then each one's Markdown, its title with a line saying where it's from (a tab's articles, then its
 * references' operations).
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
  const articleSlugs = (part: (typeof parts)[number]) => [...everyCollection(part.collections).flatMap((c) => c.articles), ...part.uncollected].map((a) => a.slug);
  const slugs = parts.flatMap(articleSlugs);
  const shown = await shownOperations(slug, docs.references.map((reference) => reference.slug));
  // ponytail: every article's text in one response; page it (or cap it) if docs ever get big enough to matter.
  const rows = await prisma.article.findMany({
    where: { ...listedArticle, project: { slug }, slug: { in: slugs } },
    select: { id: true, slug: true, title: true, description: true, keywords: true, body: true, content: true },
  });
  // At another language's address (/de/llms-full.txt): each article in its version there while it's current, at its address
  // there; else the default language's, at its own (docs/plan.md, "A page not yet translated").
  const { language, defaultLanguage, prefix } = await portalLanguage();
  const other = language && language !== defaultLanguage ? language : null;
  const versions = other ? await currentVersions(rows, [other]) : new Map<string, ShownVersion[]>();
  const bySlug = new Map(
    rows.map((row) => {
      const version = versions.get(row.id)?.[0];
      return [row.slug, version ? { ...row, title: version.title, body: version.body, content: version.content, path: `${prefix}/docs/${version.slug ?? row.slug}` } : { ...row, path: `/docs/${row.slug}` }];
    }),
  );
  // Its title, then where it's from, then what it says.
  const sourced = (markdown: string, path: string) => {
    const titleEnd = markdown.indexOf("\n");
    return `${markdown.slice(0, titleEnd)}\nSource: ${portal}${path}\n${markdown.slice(titleEnd + 1)}`;
  };
  const operations = (part: (typeof parts)[number]) =>
    part.references.flatMap((reference) => {
      const { doc, baseUrl, operations = [] } = shown.get(reference.slug) ?? {};
      return operations.map((operation) =>
        sourced(operationMarkdown(doc!, operation, { base: baseUrl ?? undefined }), `/docs/${reference.slug}/${operation.slug}`),
      );
    });
  const articles = (
    await Promise.all(
      parts.map(async (part) => [
        ...(await Promise.all(
          articleSlugs(part).flatMap((articleSlug) => {
            const row = bySlug.get(articleSlug);
            return row ? [articleMarkdown({ title: row.title, doc: displayDoc(row) }).then((markdown) => sourced(markdown, row.path))] : [];
          }),
        )),
        ...operations(part),
      ]),
    )
  ).flat();
  const title = toMarkdown({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: project.name }] }] });
  return new Response([`${title}\n`, ...articles].join("\n"), {
    // Never from a shared cache, like each article's .md: any of them may become for some readers only at any time.
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=300" },
  });
}
