import { Prisma } from "@tuti/db";
import { z } from "zod";

/**
 * Reader groups (Phase 10): the project's app says in the SSO token which groups someone is in
 * (`groups`, e.g. ["enterprise"]), the team names those groups in Settings → Groups (each matched
 * by its `claim`), and a docs collection can be for some groups only. The team reads everything;
 * everyone else reads what's for everyone. Groups are named by their `key` (from the name when
 * made, never changed) in the API, on collections and in a reader's groups.
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

/** Whose groups (keys): null is the team (everything), [] someone in no group. */
export type ReaderGroups = string[] | null;

/**
 * Selects a collection's groups' keys (`groups: groupClaims`), for `restricted` and `mayReadCollection`.
 * Named for the claims that named groups before they had keys.
 */
export const groupClaims = { select: { group: { select: { key: true } } }, orderBy: { group: { key: "asc" } } } as const;
type WithGroups = { groups: { group: { key: string } }[] };

/** The keys of a collection's groups (selected with `groupClaims`). */
export const claimsOf = (collection: WithGroups) => collection.groups.map((g) => g.group.key);

/** A collection those groups may read on its own: it's for everyone, or for one of them. */
const groupsAllow = (groups: string[]): Prisma.CollectionWhereInput => ({
  OR: [{ groups: { none: {} } }, ...(groups.length > 0 ? [{ groups: { some: { group: { key: { in: groups } } } } }] : [])],
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
  // No collection on its way up that's for some groups only, none of them theirs.
  return Prisma.sql`(a."collectionId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM collection rc
    WHERE (rc.id = a."collectionId" OR rc.id = (SELECT "parentId" FROM collection WHERE id = a."collectionId"))
      AND EXISTS (SELECT 1 FROM collection_group cg WHERE cg."collectionId" = rc.id)
      AND NOT EXISTS (
        SELECT 1 FROM collection_group cg JOIN reader_group rg ON rg.id = cg."groupId"
        WHERE cg."collectionId" = rc.id AND rg.key = ANY(${groups}::text[])
      )
  ))`;
}

/** Whether a collection (with its parent) is for some groups only. */
export const restricted = (collection: (WithGroups & { parent?: WithGroups | null }) | null | undefined) =>
  !!collection && (collection.groups.length > 0 || (collection.parent?.groups.length ?? 0) > 0);

/** Whether readers with `groups` may read a collection with these groups (and its parent's). */
export const mayReadCollection = (groups: ReaderGroups, ...collections: (WithGroups | null | undefined)[]) =>
  groups === null || collections.every((c) => !c || c.groups.length === 0 || c.groups.some((g) => groups.includes(g.group.key)));
