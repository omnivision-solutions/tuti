import { toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";

import { portalAddress } from "@/server/custom-domains";
import { formatDate } from "@/lib/format";
import { boardPath } from "@/lib/post-urls";
import { SIGNED_OUT } from "@/lib/read-access";
import { firstLine, shownOperations } from "@/server/api-reference-queries";
import { type DocsCollection, type DocsReferenceLink, docsContents, docsTabPath } from "@/server/docs-queries";
import { PORTAL_BOARDS } from "@/server/post-visibility";

const text = (value: string, href?: string) => ({ type: "text", text: value, ...(href && { marks: [{ type: "link", attrs: { href } }] }) });
const heading = (level: number, value: string, href?: string) => ({ type: "heading", attrs: { level }, content: [text(value, href)] });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
type Link = { name: string; url: string; note?: string | null };
const linkParagraph = (item: Link) => ({ type: "paragraph", content: [text(item.name, item.url), ...(item.note ? [text(`: ${item.note}`)] : [])] });
const list = (items: object[]) => ({ type: "bulletList", content: items });
const links = (items: Link[]) => list(items.map((item) => ({ type: "listItem", content: [linkParagraph(item)] })));
/** How many changelog entries it links, the newest. */
const LLMS_ENTRIES = 50;
/** Headings go to ####; collections deeper than that are list items. */
const DEEPEST_HEADING = 4;

/**
 * The portal for AI tools (llmstxt.org): what it is, then links to every docs
 * article's Markdown and every API reference's page with its operations' Markdown (by tab, if the docs have them, under links to the tabs' and collections' pages;
 * collections nest as headings to ####, then as lists), the changelog and its newest entries' Markdown, and the
 * feedback boards. Built as
 * a document so names and titles are escaped like any Markdown we serve.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/llms.txt">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      name: true,
      // The newest published entries; sample content (server/sample-content.ts) is left out, as search engines leave it.
      // ponytail: the latest 50; the changelog's pages list the rest, should an agent want older ones.
      changelogEntries: {
        where: { publishedAt: { not: null }, sample: false },
        orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
        take: LLMS_ENTRIES,
        select: { number: true, title: true, publishedAt: true },
      },
      boards: { where: PORTAL_BOARDS, orderBy: { createdAt: "asc" }, select: { slug: true, name: true, description: true } },
    },
  });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  const portal = await portalAddress(slug);
  // For AI tools, like search engines: what's for everyone (nothing for signed-in readers or some groups only),
  // and not the articles whose team blocked search indexing.
  const docs = await docsContents(slug, { reader: SIGNED_OUT, indexable: true, locks: false });
  const { collections, uncollected, tabs, references } = docs;
  // An API reference's page with its description's first line, and under it a line per operation on the help center
  // linking its Markdown, with its method, path and its description's first line.
  const shown = await shownOperations(slug, references.map((reference) => reference.slug));
  const lines = new Map(
    await Promise.all(
      [...shown].map(async ([referenceSlug, { doc, operations }]) => {
        const items = await Promise.all(
          operations.map(async (operation) => {
            const line = await firstLine(operation.description);
            const url = `${portal}/docs/${referenceSlug}/${operation.slug}.md`;
            return { type: "listItem", content: [linkParagraph({ name: operation.title, url, note: `${operation.kind} ${operation.path}${line && `. ${line}`}` })] };
          }),
        );
        return [referenceSlug, { note: await firstLine(doc.description), items }] as const;
      }),
    ),
  );
  const referenceLinks = (references: DocsReferenceLink[]) =>
    references.length > 0
      ? [
          list(
            references.map((reference) => {
              const { note, items = [] } = lines.get(reference.slug) ?? {};
              return {
                type: "listItem",
                content: [linkParagraph({ name: reference.name, url: `${portal}/docs/${reference.slug}`, note }), ...(items.length > 0 ? [list(items)] : [])],
              };
            }),
          ),
        ]
      : [];
  const articleItem = (article: { slug: string; title: string }) => ({
    type: "listItem",
    content: [linkParagraph({ name: article.title, url: `${portal}/docs/${article.slug}.md` })],
  });
  const articleLinks = (articles: { slug: string; title: string }[]) => list(articles.map(articleItem));
  // Past the deepest heading: an item linking its page, with its articles and the collections in it nested under it.
  // A sample collection (server/sample-content.ts) holding the team's pages: those, without its own name, text or link.
  const collectionItems = (collection: DocsCollection): object[] => {
    const items = [...collection.articles.map(articleItem), ...collection.collections.flatMap(collectionItems)];
    if (collection.sample) {
      return items;
    }
    return [
      {
        type: "listItem",
        content: [linkParagraph({ name: collection.name, url: `${portal}/docs/${collection.slug}`, note: collection.description }), ...(items.length > 0 ? [list(items)] : [])],
      },
    ];
  };
  // A collection's heading, its articles, then the collections in it a level down (or, from the deepest heading, listed with its articles).
  const collectionBlocks = (collection: DocsCollection, level: number): object[] => {
    const listed = level < DEEPEST_HEADING ? [] : collection.collections;
    const items = [...collection.articles.map(articleItem), ...listed.flatMap(collectionItems)];
    // A sample collection holding the team's pages: they take its place, at its level (its articles under a heading of
    // their own, not the one before), without its name, text or link.
    if (collection.sample) {
      return [
        ...(collection.articles.length > 0 ? [heading(level, "More articles"), articleLinks(collection.articles)] : []),
        ...collection.collections.flatMap((child) => collectionBlocks(child, level)),
      ];
    }
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
    { type: "paragraph", content: [text("Every docs article's full text: "), text("llms-full.txt", `${portal}/llms-full.txt`)] },
    ...(tabs.length > 0
      ? // A tab's heading, then its collections a level down; the first has the articles in none.
        tabs.flatMap((tab) => [
          heading(2, tab.name, `${portal}${docsTabPath(docs, tab.slug)}`),
          ...referenceLinks(tab.references),
          ...tab.collections.flatMap((collection) => collectionBlocks(collection, 3)),
          ...(tab.uncollected.length > 0 ? [heading(3, "More articles"), articleLinks(tab.uncollected)] : []),
        ])
      : [
          // Under a heading of their own: llms.txt's links are the lists under one.
          ...(references.length > 0 ? [heading(2, "API references"), ...referenceLinks(references)] : []),
          ...collections.flatMap((collection) => collectionBlocks(collection, 2)),
          ...(uncollected.length > 0 ? [heading(2, collections.length > 0 ? "More articles" : "Docs"), articleLinks(uncollected)] : []),
        ]),
    heading(2, "Changelog"),
    links([
      { name: "Changelog", url: `${portal}/changelog`, note: `What's new, improved and fixed in ${project.name}` },
      ...project.changelogEntries.map((entry) => ({ name: entry.title, url: `${portal}/changelog/${entry.number}.md`, note: formatDate(entry.publishedAt!) })),
    ]),
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
