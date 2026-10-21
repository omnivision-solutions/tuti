import { toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";

import { portalAddress } from "@/server/custom-domains";
import { boardPath } from "@/lib/post-urls";
import { type HelpCollection, helpCenter } from "@/server/help-queries";

const text = (value: string, href?: string) => ({ type: "text", text: value, ...(href && { marks: [{ type: "link", attrs: { href } }] }) });
const heading = (level: number, value: string) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
const links = (items: { name: string; url: string; note?: string | null }[]) => ({
  type: "bulletList",
  content: items.map((item) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: [text(item.name, item.url), ...(item.note ? [text(`: ${item.note}`)] : [])] }],
  })),
});

/**
 * The portal for AI tools (llmstxt.org): what it is, then links to every help
 * article's Markdown (by section, if the help center has them), the changelog and the feedback boards. Built as a document
 * so names and titles are escaped like any Markdown we serve.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/llms.txt">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { name: true, boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true, description: true } } },
  });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  const portal = await portalAddress(slug);
  // For AI tools, like search engines: what's for everyone (not collections for some reader groups only).
  const { collections, uncollected, sections } = await helpCenter(slug, { groups: [] });
  const articleLinks = (articles: { slug: string; title: string }[]) =>
    links(articles.map((article) => ({ name: article.title, url: `${portal}/docs/${article.slug}.md` })));
  // A collection's heading, its articles, then the collections in it a level down.
  const section = (collection: HelpCollection, level: number): object[] => [
    heading(level, collection.name),
    ...(collection.description ? [paragraph(collection.description)] : []),
    ...(collection.articles.length > 0 ? [articleLinks(collection.articles)] : []),
    ...collection.collections.flatMap((child) => section(child, level + 1)),
  ];

  const content = [
    heading(1, project.name),
    { type: "blockquote", content: [paragraph(`Docs, changelog and feedback for ${project.name}.`)] },
    ...(sections.length > 0
      ? // A section's heading, then its collections a level down; the first has the articles in none.
        sections.flatMap((tab) => [
          heading(2, tab.name),
          ...tab.collections.flatMap((collection) => section(collection, 3)),
          ...(tab.uncollected.length > 0 ? [heading(3, "More articles"), articleLinks(tab.uncollected)] : []),
        ])
      : [
          ...collections.flatMap((collection) => section(collection, 2)),
          ...(uncollected.length > 0 ? [heading(2, collections.length > 0 ? "More articles" : "Docs"), articleLinks(uncollected)] : []),
        ]),
    heading(2, "Changelog"),
    links([{ name: "Changelog", url: `${portal}/changelog`, note: `What's new, improved and fixed in ${project.name}` }]),
    heading(2, "Feedback"),
    links([
      ...project.boards.map((board) => ({ name: board.name, url: `${portal}${boardPath(board)}`, note: board.description })),
      { name: "Roadmap", url: `${portal}/roadmap`, note: "What's planned, being built and done" },
    ]),
  ];
  return new Response(`${toMarkdown({ type: "doc", content })}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
