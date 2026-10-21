import type { ReadAccess } from "@tuti/db";

/**
 * "Who can read" a docs tab, collection or article (ReadAccess in the schema, lowercase in the API):
 * `inherit` (what the level above allows; for a tab, everyone who may read the portal), `signed_in`
 * (anyone signed in on the portal) or `groups` (readers in one of its groups; with none, only the
 * team). A page is readable when every level from its tab down to it lets the reader through
 * (`readable`), so a level can only narrow what's above it. The team reads everything.
 *
 * Safe for the browser: the Prisma and SQL forms of the same are in lib/reader-groups.ts.
 */

export const ACCESSES = ["inherit", "signed_in", "groups"] as const;
export type Access = (typeof ACCESSES)[number];

export const toReadAccess = (access: Access) => access.toUpperCase() as ReadAccess;
export const fromReadAccess = (access: ReadAccess) => access.toLowerCase() as Access;

/** Who's reading: null is the team (everything); else whether they're signed in on the portal, and their groups' keys. */
export type Reader = { signedIn: boolean; groups: string[] } | null;

/** Signed out, in no group: what's for everyone (search engines, llms.txt and the sitemap get this). */
export const SIGNED_OUT: Reader = { signedIn: false, groups: [] };

/** A tab's, collection's or article's "Who can read", with its groups' keys (see `levelSelect` in lib/reader-groups.ts). */
export type Level = { access: ReadAccess; groups: { group: { key: string } }[] };

/** Whether one level lets `reader` through on its own; a missing one (no tab) does. */
export function allows(reader: Reader, level: Level | null | undefined): boolean {
  if (reader === null || !level) {
    return true;
  }
  switch (level.access) {
    case "INHERIT":
      return true;
    case "SIGNED_IN":
      return reader.signedIn;
    case "GROUPS":
      return level.groups.some((g) => reader.groups.includes(g.group.key));
  }
}

/** Whether `reader` may read a page under these levels (its tab, each collection, the page): every one must let them through. */
export const readable = (reader: Reader, ...levels: (Level | null | undefined)[]) => levels.every((level) => allows(reader, level));

/** Whether any of these levels is for some readers only (then the page is never kept by shared caches). */
export const restricted = (levels: (Level | null | undefined)[]) => levels.some((level) => level && level.access !== "INHERIT");

/** Levels as the team reads them: "Who can read" with its groups' names. */
export type NamedLevel = { access: ReadAccess; groups: string[] };

const or = (names: string[]) => new Intl.ListFormat("en-GB", { type: "disjunction" }).format(names);

/**
 * Who may read a page under these levels together, in words for the team: "Anyone can read it",
 * "Signed-in readers", "Readers in Enterprise or Pro" (and "…, and in Beta" for each level more),
 * or "Only your team".
 */
export function describeAccess(levels: NamedLevel[]): string {
  const groups = levels.filter((level) => level.access === "GROUPS");
  if (groups.some((level) => level.groups.length === 0)) {
    return "Only your team";
  }
  if (groups.length > 0) {
    return `Readers in ${groups.map((level) => or(level.groups)).join(", and in ")}`;
  }
  return levels.some((level) => level.access === "SIGNED_IN") ? "Signed-in readers" : "Anyone can read it";
}

/** A row's badge for one level that isn't inherit: "Signed-in", "Enterprise, Pro" or "Team only"; null for inherit. */
export function accessBadge(level: NamedLevel): string | null {
  switch (level.access) {
    case "INHERIT":
      return null;
    case "SIGNED_IN":
      return "Signed-in";
    case "GROUPS":
      return level.groups.length > 0 ? level.groups.join(", ") : "Team only";
  }
}
