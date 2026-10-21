import { Prisma } from "@tuti/db";
import { z } from "zod";

import { MAX_COLLECTION_DEPTH } from "./collection-tree";
import { allows, type Level, type Reader } from "./read-access";

/**
 * Reader groups (Phase 10): the project's app says in the SSO token which groups someone is in
 * (`groups`, e.g. ["enterprise"]), the team names those groups in Settings → Groups (each matched
 * by its `claim`), and a docs tab, collection or article can be for signed-in readers or some groups
 * only (lib/read-access.ts). The team reads everything. Groups are named by their `key` (from the
 * name when made, never changed) in the API, on tabs, collections and articles, and in a reader's groups.
 *
 * Here: the same rule (`readable`) as a Prisma filter and as SQL, for queries on articles.
 */

export const MAX_READER_GROUPS = 20;

/** A group's claim or key: lowercase letters, digits, and - _ . : (e.g. "enterprise", "plan:pro"). */
export const readerGroup = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/, "Groups are lowercase letters, digits, and - _ . :");

/**
 * Selects a tab's, collection's or article's groups' keys (`groups: groupClaims`). Named for the
 * claims that named groups before they had keys.
 */
export const groupClaims = { select: { group: { select: { key: true } } }, orderBy: { group: { key: "asc" } } } as const;

/** Selects a tab's, collection's or article's "Who can read" (a Level), and what the rest see of it (see `locks`). */
export const levelSelect = { access: true, groups: groupClaims, noAccess: true } as const;

/** The keys of a level's groups (selected with `groupClaims`). */
export const claimsOf = (level: { groups: { group: { key: string } }[] }) => level.groups.map((g) => g.group.key);

/** Tabs, collections or articles that let `reader` (not the team) through on their own: `allows` as a filter. */
const levelAllows = (reader: NonNullable<Reader>) => ({
  OR: [
    { access: "INHERIT" as const },
    ...(reader.signedIn ? [{ access: "SIGNED_IN" as const }] : []),
    ...(reader.groups.length > 0 ? [{ access: "GROUPS" as const, groups: { some: { group: { key: { in: reader.groups } } } } }] : []),
  ],
});

/** A top-level collection's tab lets them through (or it has none: the docs have no tabs). */
const tabAllows = (reader: NonNullable<Reader>): Prisma.CollectionWhereInput => ({ OR: [{ tabId: null }, { tab: levelAllows(reader) }] });

/**
 * A collection `reader` may read, with every one it's in and the top-level one's tab, `levels` deep at
 * most: one deeper (which the operations never make) isn't for them.
 */
const treeAllows = (reader: NonNullable<Reader>, levels: number): Prisma.CollectionWhereInput => ({
  AND: [
    levelAllows(reader),
    levels === 1 ? { parentId: null, ...tabAllows(reader) } : { OR: [{ parentId: null, ...tabAllows(reader) }, { parent: treeAllows(reader, levels - 1) }] },
  ],
});

/**
 * Articles `reader` may read: the article lets them through, and so do its collection, every one
 * it's in and their tab, or (in no collection) the docs' first tab (`firstTab`: see firstTabLevel in
 * server/docs-queries.ts; null without tabs). Everything for the team.
 */
export function visibleArticle(reader: Reader, firstTab: Level | null): Prisma.ArticleWhereInput {
  if (reader === null) {
    return {};
  }
  return {
    AND: [levelAllows(reader), { OR: [...(allows(reader, firstTab) ? [{ collectionId: null }] : []), { collection: treeAllows(reader, MAX_COLLECTION_DEPTH) }] }],
  };
}

/** `allows` in SQL, for the level at `alias` (tab, collection or article) whose groups are in `table` by `column`. */
function levelSql(reader: NonNullable<Reader>, alias: string, table: string, column: string): Prisma.Sql {
  const [level, links, by] = [Prisma.raw(alias), Prisma.raw(table), Prisma.raw(`"${column}"`)];
  return Prisma.sql`(${level}.access = 'INHERIT'
    OR (${level}.access = 'SIGNED_IN' AND ${reader.signedIn})
    OR (${level}.access = 'GROUPS' AND EXISTS (
      SELECT 1 FROM ${links} l JOIN reader_group rg ON rg.id = l."groupId"
      WHERE l.${by} = ${level}.id AND rg.key = ANY(${reader.groups}::text[])
    )))`;
}

/** `visibleArticle` for raw SQL, on article alias `a` (true for the team). */
export function visibleArticleSql(reader: Reader): Prisma.Sql {
  if (reader === null) {
    return Prisma.sql`TRUE`;
  }
  // In no collection: the project's first tab (if it has tabs). In one: it and every one it's in (UNION,
  // not UNION ALL, so it ends), and the top-level one's tab; none may keep the reader out.
  return Prisma.sql`(${levelSql(reader, "a", "article_group", "articleId")} AND (
    (a."collectionId" IS NULL AND NOT EXISTS (
      SELECT 1 FROM (SELECT t.id, t.access FROM docs_tab t WHERE t."projectId" = a."projectId" ORDER BY t."order", t.name LIMIT 1) t
      WHERE NOT ${levelSql(reader, "t", "tab_group", "tabId")}
    ))
    OR (a."collectionId" IS NOT NULL AND NOT EXISTS (
      WITH RECURSIVE up AS (
        SELECT id, "parentId", "tabId", access FROM collection WHERE id = a."collectionId"
        UNION SELECT c.id, c."parentId", c."tabId", c.access FROM collection c JOIN up ON c.id = up."parentId"
      )
      SELECT 1 FROM up LEFT JOIN docs_tab t ON t.id = up."tabId" AND up."parentId" IS NULL
      WHERE NOT ${levelSql(reader, "up", "collection_group", "collectionId")}
        OR (t.id IS NOT NULL AND NOT ${levelSql(reader, "t", "tab_group", "tabId")})
    ))
  ))`;
}
