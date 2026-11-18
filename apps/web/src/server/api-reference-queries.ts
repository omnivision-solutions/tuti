import { type Doc, fromPlainText, toPlainText } from "@tuti/content";
import { htmlToContent } from "@tuti/content/html";
import { prisma } from "@tuti/db";
import { type ApiDoc, type ApiReferenceState, onHelpCenter } from "@tuti/shared/api-reference";
import { marked } from "marked";
import { cache } from "react";

import { locks, readable, restricted } from "@/lib/read-access";
import { levelSelect } from "@/lib/reader-groups";

import { firstTabLevel } from "./docs-queries";
import { currentReader } from "./portal-access";

/** Reads for the portal's API reference pages (docs/plan.md, API reference in Docs). */

/**
 * What reference `slug` is to this reader, once per request (the page, its metadata and the tabs' row):
 * what `onHelpCenter` gives of it (its operations in the tree's order), when it's published and has an operation there; null otherwise. It
 * has no access of its own: it's read by whoever may read its tab, as an article in that tab is (one
 * in no tab, like an article in no collection, is under the first). To everyone else it's as good as
 * missing, unless the tab shows what's in it with a lock: then `locked`, with its operations' titles
 * and nothing they say.
 */
export const apiReferencePage = cache(async (projectSlug: string, slug: string) => {
  const row = await prisma.apiReference.findFirst({
    where: { project: { slug: projectSlug }, slug, publishedAt: { not: null }, shownCount: { gt: 0 } },
    select: {
      projectId: true,
      tabId: true,
      slug: true,
      name: true,
      baseUrl: true,
      treeStyle: true,
      doc: true,
      state: true,
      tab: { select: { slug: true, ...levelSelect } },
    },
  });
  if (!row) {
    return null;
  }
  const doc = row.doc as unknown as ApiDoc;
  const shown = onHelpCenter(doc, row.state as unknown as ApiReferenceState);
  const { groups } = shown;
  // As the tree lists them: by group in the team's order (the sort is stable: the spec's order within one). The first is where the reference's own address goes.
  const place = new Map(groups.map((group, at) => [group.key, at]));
  const operations = shown.operations.toSorted((a, b) => place.get(a.group)! - place.get(b.group)!);
  const level = row.tab ?? (await firstTabLevel(row.projectId));
  const isRestricted = restricted([level]);
  const reader = isRestricted ? await currentReader(row.projectId) : null;
  const reference = { slug: row.slug, name: row.name };
  const tab = row.tab?.slug ?? null;
  if (!readable(reader, level)) {
    if (!locks(level)) {
      return null;
    }
    // Picked field by field: nothing of what they say.
    return { kind: "locked" as const, reference, tab, operations: operations.map(({ slug, title }) => ({ slug, title })), signedIn: reader?.signedIn ?? false };
  }
  return {
    kind: "reference" as const,
    projectId: row.projectId,
    reference: { ...reference, baseUrl: row.baseUrl, treeStyle: row.treeStyle },
    tab,
    doc,
    groups,
    operations,
    /** For some readers only: never for search engines. */
    restricted: isRestricted,
  };
});

export type ApiReferencePage = NonNullable<Awaited<ReturnType<typeof apiReferencePage>>>;

/** A line with none of Markdown's marks: no address or email Markdown would link, and no two spaces at its end (a line break). */
const PLAIN = /^(?![ \t]*(?:[-+]|\d+[.)])[ \t]|[ \t]*-{3,}[ \t]*$| {4}|\t|.*(?::\/\/|www\.|@| {2,}\r?$))[^\\`*_[\]<>#|~&=]*$/;

/**
 * A spec's Markdown (a description) as content for RichText. A spec is untrusted: its Markdown becomes
 * HTML, which goes through the converter imports use (scripts, styles and attributes dropped, links kept
 * only when safe, images left out), and RichText renders the result as elements, never as markup.
 */
export const markdownDoc = cache(async (text: string): Promise<Doc> => {
  // Most parameters' descriptions are a plain sentence: no parser for those. As Markdown reads them: a blank line
  // between paragraphs, and a line the spec wrapped is the same paragraph going on.
  if (text.split("\n").every((line) => PLAIN.test(line))) {
    const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim().split(/\s*\n\s*/).join(" "));
    return fromPlainText(paragraphs.join("\n\n"));
  }
  const content = await htmlToContent("article", marked.parse(text, { async: false, gfm: true }));
  return "error" in content ? fromPlainText(text) : content.doc;
});

/** A spec's Markdown as plain words, its first line only: a card's, a search listing's or llms.txt's description. */
export async function firstLine(text: string | undefined): Promise<string> {
  return text?.trim() ? (toPlainText(await markdownDoc(text)).split("\n").find((line) => line.trim()) ?? "").trim() : "";
}

/**
 * The first line of each of these references' descriptions, by slug (llms.txt). Read from inside the stored doc, as lists
 * never load a whole one.
 */
export async function referenceDescriptions(projectSlug: string, slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) {
    return new Map();
  }
  const rows = await prisma.$queryRaw<{ slug: string; description: string | null }[]>`
    SELECT r.slug, r.doc->>'description' AS description
    FROM api_reference r JOIN project p ON p.id = r."projectId"
    WHERE p.slug = ${projectSlug} AND r.slug = ANY(${slugs})`;
  return new Map(await Promise.all(rows.map(async (row) => [row.slug, await firstLine(row.description ?? undefined)] as const)));
}
