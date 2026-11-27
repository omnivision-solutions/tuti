import { toPlainText } from "@tuti/content";
import { prisma } from "@tuti/db";

import { SIGNED_OUT } from "@/lib/read-access";
import { portalAddress } from "@/server/custom-domains";
import { entryLanguageAsked, publishedEntries } from "@/server/changelog-queries";
import { portalLanguage } from "@/server/portal-base";
import { portalTranslator } from "@/server/portal-language";

/** Characters XML 1.0 forbids (most control characters): one would make the whole feed invalid. */
const FORBIDDEN = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const xml = (text: string) =>
  text
    .replace(FORBIDDEN, "")
    .replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** The portal's changelog as an RSS 2.0 feed: the latest published entries. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/changelog/rss.xml">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  // In the address's language (/de/changelog/rss.xml): its title, description and the entries' tags, and its links to that
  // language's pages (the entries are the team's words).
  const [address, { prefix, defaultLanguage }, { t, language }, asked] = await Promise.all([portalAddress(slug), portalLanguage(), portalTranslator(project.id, "changelog"), entryLanguageAsked()]);
  const portal = `${address}${prefix}`;
  // Not sample content (Home's "Add sample content"): feed readers keep what they're sent. For everyone only: no feed
  // reader signs in, and it's kept in shared caches. Each entry in the address's language where its version there is
  // current, else the default language's (docs/plan.md L17, as the changelog's pages).
  const entries = await publishedEntries(slug, SIGNED_OUT, { withSample: false, language: asked });
  const items = entries.map((entry) => {
    // At this language's address either way (its page there shows the default language's with a line until it's
    // translated): its guid stays the same once it is, so feed readers don't list it twice.
    const url = `${portal}/changelog/${entry.number}`;
    // Not translated into the feed's language: its title and text are the default language's, and say so (as its page's
    // `lang`); its tags are the feed's.
    const lang = entry.untranslated && defaultLanguage ? ` xml:lang="${xml(defaultLanguage)}"` : "";
    return [
      "<item>",
      `<title${lang}>${xml(entry.title)}</title>`,
      `<link>${xml(url)}</link>`,
      `<guid isPermaLink="true">${xml(url)}</guid>`,
      `<pubDate>${entry.publishedAt.toUTCString()}</pubDate>`,
      ...entry.tags.map((tag) => `<category>${xml(t(`tag.${tag}`))}</category>`),
      `<description${lang}>${xml(toPlainText(entry.doc))}</description>`,
      "</item>",
    ].join("");
  });
  const feed = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${xml(t("rssTitle", { name: project.name }))}</title>`,
    `<link>${xml(`${portal}/changelog`)}</link>`,
    `<atom:link href="${xml(`${portal}/changelog/rss.xml`)}" rel="self" type="application/rss+xml"/>`,
    `<description>${xml(t("description", { name: project.name }))}</description>`,
    // The feed's language: its address's.
    `<language>${xml(language)}</language>`,
    ...items,
    "</channel>",
    "</rss>",
  ].join("\n");
  return new Response(feed, {
    headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
