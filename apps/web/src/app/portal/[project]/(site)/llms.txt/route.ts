import { toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";

import { portalUrl } from "@/lib/hosts";
import { helpCenter } from "@/server/help-queries";

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
 * article's Markdown, the changelog and the feedback boards. Built as a document
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
  const portal = portalUrl(slug);
  const { collections, uncollected } = await helpCenter(slug);
  const articleLinks = (articles: { slug: string; title: string }[]) =>
    links(articles.map((article) => ({ name: article.title, url: `${portal}/help/${article.slug}.md` })));

  const content = [
    heading(1, project.name),
    { type: "blockquote", content: [paragraph(`Help center, changelog and feedback for ${project.name}.`)] },
    ...collections.flatMap((collection) => [
      heading(2, collection.name),
      ...(collection.description ? [paragraph(collection.description)] : []),
      articleLinks(collection.articles),
    ]),
    ...(uncollected.length > 0 ? [heading(2, collections.length > 0 ? "More articles" : "Help center"), articleLinks(uncollected)] : []),
    heading(2, "Changelog"),
    links([{ name: "Changelog", url: `${portal}/changelog`, note: `What's new, improved and fixed in ${project.name}` }]),
    heading(2, "Feedback"),
    links([
      ...project.boards.map((board) => ({ name: board.name, url: `${portal}/b/${board.slug}`, note: board.description })),
      { name: "Roadmap", url: `${portal}/roadmap`, note: "What's planned, being built and done" },
    ]),
  ];
  return new Response(`${toMarkdown({ type: "doc", content })}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
