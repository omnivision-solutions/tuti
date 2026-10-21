import { Prisma } from "@tuti/db";
import { z } from "zod";

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

/** Articles readers with `groups` may read: in no collection, or in one they may read (and its parent too). */
export function visibleArticle(groups: ReaderGroups): Prisma.ArticleWhereInput {
  if (groups === null) {
    return {};
  }
  return {
    OR: [
      { collectionId: null },
      { collection: { AND: [groupsAllow(groups), { OR: [{ parentId: null }, { parent: groupsAllow(groups) }] }] } },
    ],
  };
}

/** The same for raw SQL, on article alias `a` (true for the team). */
export function visibleArticleSql(groups: ReaderGroups): Prisma.Sql {
  if (groups === null) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`(a."collectionId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM collection rc
    WHERE (rc.id = a."collectionId" OR rc.id = (SELECT "parentId" FROM collection WHERE id = a."collectionId"))
      AND cardinality(rc.groups) > 0 AND NOT (rc.groups && ${groups}::text[])
  ))`;
}

/** Whether a collection (with its parent) is for some groups only. */
export const restricted = (collection: { groups: string[]; parent?: { groups: string[] } | null } | null | undefined) =>
  !!collection && (collection.groups.length > 0 || (collection.parent?.groups.length ?? 0) > 0);

/** Whether readers with `groups` may read a collection with these groups (and its parent's). */
export const mayReadCollection = (groups: ReaderGroups, ...collections: ({ groups: string[] } | null | undefined)[]) =>
  groups === null || collections.every((c) => !c || c.groups.length === 0 || c.groups.some((g) => groups.includes(g)));
