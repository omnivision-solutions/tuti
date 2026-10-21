import { toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";

import { portalAddress } from "@/server/custom-domains";
import { boardPath } from "@/lib/post-urls";
import { SIGNED_OUT } from "@/lib/read-access";
import { type DocsCollection, docsContents, docsTabPath } from "@/server/docs-queries";

const text = (value: string, href?: string) => ({ type: "text", text: value, ...(href && { marks: [{ type: "link", attrs: { href } }] }) });
const heading = (level: number, value: string, href?: string) => ({ type: "heading", attrs: { level }, content: [text(value, href)] });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
type Link = { name: string; url: string; note?: string | null };
const linkParagraph = (item: Link) => ({ type: "paragraph", content: [text(item.name, item.url), ...(item.note ? [text(`: ${item.note}`)] : [])] });
const list = (items: object[]) => ({ type: "bulletList", content: items });
const links = (items: Link[]) => list(items.map((item) => ({ type: "listItem", content: [linkParagraph(item)] })));
/** Headings go to ####; collections deeper than that are list items. */
const DEEPEST_HEADING = 4;

/**
 * The portal for AI tools (llmstxt.org): what it is, then links to every docs
 * article's Markdown (by tab, if the docs have them, under links to the tabs' and collections' pages;
 * collections nest as headings to ####, then as lists), the changelog and the feedback boards. Built as
 * a document so names and titles are escaped like any Markdown we serve.
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
  // For AI tools, like search engines: what's for everyone (nothing for signed-in readers or some groups only).
  const docs = await docsContents(slug, { reader: SIGNED_OUT, locks: false });
  const { collections, uncollected, tabs } = docs;
  const articleItem = (article: { slug: string; title: string }) => ({
    type: "listItem",
    content: [linkParagraph({ name: article.title, url: `${portal}/docs/${article.slug}.md` })],
  });
  const articleLinks = (articles: { slug: string; title: string }[]) => list(articles.map(articleItem));
  // Past the deepest heading: an item linking its page, with its articles and the collections in it nested under it.
  const collectionItem = (collection: DocsCollection): object => {
    const items = [...collection.articles.map(articleItem), ...collection.collections.map(collectionItem)];
    return {
      type: "listItem",
      content: [linkParagraph({ name: collection.name, url: `${portal}/docs/${collection.slug}`, note: collection.description }), ...(items.length > 0 ? [list(items)] : [])],
    };
  };
  // A collection's heading, its articles, then the collections in it a level down (or, from the deepest heading, listed with its articles).
  const collectionBlocks = (collection: DocsCollection, level: number): object[] => {
    const listed = level < DEEPEST_HEADING ? [] : collection.collections;
    const items = [...collection.articles.map(articleItem), ...listed.map(collectionItem)];
    return [
      heading(level, collection.name, `${portal}/docs/${collection.slug}`),
      ...(collection.description ? [paragraph(collection.description)] : []),
      ...(items.length > 0 ? [list(items)] : []),
      ...(level < DEEPEST_HEADING ? collection.collections.flatMap((child) => collectionBlocks(child, level + 1)) : []),
    ];
  };

  const content = [
    heading(1, project.name),
    { type: "blockquote", content: [paragraph(`Docs, changelog and feedback for ${project.name}.`)] },
    ...(tabs.length > 0
      ? // A tab's heading, then its collections a level down; the first has the articles in none.
        tabs.flatMap((tab) => [
          heading(2, tab.name, `${portal}${docsTabPath(docs, tab.slug)}`),
          ...tab.collections.flatMap((collection) => collectionBlocks(collection, 3)),
          ...(tab.uncollected.length > 0 ? [heading(3, "More articles"), articleLinks(tab.uncollected)] : []),
        ])
      : [
          ...collections.flatMap((collection) => collectionBlocks(collection, 2)),
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
