import { Prisma } from "@tuti/db";
import { z } from "zod";

import { MAX_COLLECTION_DEPTH } from "./collection-tree";

/**
 * Reader groups (Phase 10): the project's app says in the SSO token which groups someone is in
 * (`groups`, e.g. ["enterprise"]), and a docs collection can be for some groups only. The
 * team reads everything; everyone else reads what's for everyone.
 */

export const MAX_READER_GROUPS = 20;

/** A group's name: lowercase letters, digits, and - _ . : (e.g. "enterprise", "plan:pro"). */
export const readerGroup = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/, "Groups are lowercase letters, digits, and - _ . :");

/** Whose groups: null is the team (everything), [] someone in no group. */
export type ReaderGroups = string[] | null;

/** A collection those groups may read on its own: it's for everyone, or for one of them. */
const groupsAllow = (groups: string[]): Prisma.CollectionWhereInput => ({
  OR: [{ groups: { isEmpty: true } }, ...(groups.length > 0 ? [{ groups: { hasSome: groups } }] : [])],
});

/**
 * A collection those groups may read, with every one it's in, `levels` deep at most: one deeper
 * (which the operations never make) isn't for them.
 */
const treeAllows = (groups: string[], levels: number): Prisma.CollectionWhereInput => ({
  AND: [groupsAllow(groups), levels === 1 ? { parentId: null } : { OR: [{ parentId: null }, { parent: treeAllows(groups, levels - 1) }] }],
});

/** Articles readers with `groups` may read: in no collection, or in one they may read (and every one it's in). */
export function visibleArticle(groups: ReaderGroups): Prisma.ArticleWhereInput {
  if (groups === null) {
    return {};
  }
  return { OR: [{ collectionId: null }, { collection: treeAllows(groups, MAX_COLLECTION_DEPTH) }] };
}

/** The same for raw SQL, on article alias `a` (true for the team). */
export function visibleArticleSql(groups: ReaderGroups): Prisma.Sql {
  if (groups === null) {
    return Prisma.sql`TRUE`;
  }
  // Its collection and every one it's in: none may be for other groups only (UNION, not UNION ALL, so it ends).
  return Prisma.sql`(a."collectionId" IS NULL OR NOT EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, "parentId", groups FROM collection WHERE id = a."collectionId"
      UNION SELECT c.id, c."parentId", c.groups FROM collection c JOIN up ON c.id = up."parentId"
    )
    SELECT 1 FROM up WHERE cardinality(up.groups) > 0 AND NOT (up.groups && ${groups}::text[])
  ))`;
}

/** Whether a collection (with the ones it's in, from ancestry) is for some groups only. */
export const restricted = (collections: { groups: string[] }[]) => collections.some((c) => c.groups.length > 0);

/** Whether readers with `groups` may read a collection with these groups (and the ones it's in). */
export const mayReadCollection = (groups: ReaderGroups, ...collections: ({ groups: string[] } | null | undefined)[]) =>
  groups === null || collections.every((c) => !c || c.groups.length === 0 || c.groups.some((g) => groups.includes(g)));
