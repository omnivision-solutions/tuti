import { toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";

import { portalAddress } from "@/server/custom-domains";
import { publishedEntries } from "@/server/changelog-queries";

/** Characters XML 1.0 forbids (most control characters): one would make the whole feed invalid. */
const FORBIDDEN = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const xml = (text: string) =>
  text
    .replace(FORBIDDEN, "")
    .replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** The portal's changelog as an RSS 2.0 feed: the latest published entries. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/changelog/rss.xml">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { name: true } });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  const portal = await portalAddress(slug);
  // Not sample content (Home's "Add sample content"): feed readers keep what they're sent.
  const entries = (await publishedEntries(slug)).filter((entry) => !entry.sample);
  const items = entries.map((entry) => {
    const url = `${portal}/changelog/${entry.number}`;
    return [
      "<item>",
      `<title>${xml(entry.title)}</title>`,
      `<link>${xml(url)}</link>`,
      `<guid isPermaLink="true">${xml(url)}</guid>`,
      `<pubDate>${entry.publishedAt.toUTCString()}</pubDate>`,
      ...entry.tags.map((tag) => `<category>${xml(tag.charAt(0) + tag.slice(1).toLowerCase())}</category>`),
      `<description>${xml(toPlainText(entry.doc))}</description>`,
      "</item>",
    ].join("");
  });
  const feed = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${xml(`${project.name} changelog`)}</title>`,
    `<link>${xml(`${portal}/changelog`)}</link>`,
    `<atom:link href="${xml(`${portal}/changelog/rss.xml`)}" rel="self" type="application/rss+xml"/>`,
    `<description>${xml(`What's new, improved and fixed in ${project.name}.`)}</description>`,
    ...items,
    "</channel>",
    "</rss>",
  ].join("\n");
  return new Response(feed, {
    headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
