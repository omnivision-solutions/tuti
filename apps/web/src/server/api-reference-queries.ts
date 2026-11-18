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
      tryIt: true,
      doc: true,
      state: true,
      tab: { select: { slug: true, ...levelSelect } },
    },
  });
  if (!row) {
    return null;
  }
  const doc = row.doc as unknown as ApiDoc;
  const { groups, operations } = shownInOrder(doc, row.state);
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
    reference: { ...reference, baseUrl: row.baseUrl, treeStyle: row.treeStyle, tryIt: row.tryIt },
    tab,
    doc,
    groups,
    operations,
    /** For some readers only: never for search engines. */
    restricted: isRestricted,
  };
});

/**
 * What `onHelpCenter` gives, its operations as the tree lists them: by group in the team's order (the sort is stable: the
 * spec's order within one). The first is where the reference's own address goes.
 */
function shownInOrder(doc: ApiDoc, state: unknown) {
  const { groups, operations } = onHelpCenter(doc, state as ApiReferenceState);
  const place = new Map(groups.map((group, at) => [group.key, at]));
  return { groups, operations: operations.toSorted((a, b) => place.get(a.group)! - place.get(b.group)!) };
}

/**
 * These references' docs, by slug, with the operations on the help center in the tree's order and when the spec last
 * changed them (llms.txt, llms-full.txt and the sitemap). Only references `docsContents` listed to the reader go in: this
 * checks nothing itself. ponytail: loads each one's whole doc; read the operations from inside it if docs get huge.
 */
export async function shownOperations(projectSlug: string, slugs: string[]) {
  const rows =
    slugs.length === 0
      ? []
      : await prisma.apiReference.findMany({
          where: { project: { slug: projectSlug }, slug: { in: slugs }, publishedAt: { not: null } },
          select: { slug: true, baseUrl: true, changedAt: true, doc: true, state: true },
        });
  return new Map(
    rows.map((row) => {
      const doc = row.doc as unknown as ApiDoc;
      return [row.slug, { doc, baseUrl: row.baseUrl, changedAt: row.changedAt, operations: shownInOrder(doc, row.state).operations }] as const;
    }),
  );
}

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
