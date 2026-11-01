import { Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { z } from "zod";

import { type GroupCondition, groupConditions, storedConditions } from "@/lib/group-conditions";
import { titleSlug } from "@/lib/post-urls";
import { readerGroup } from "@/lib/reader-groups";

import { inGroupSql } from "../group-conditions-sql";
import { defineOperation, OperationError } from "./define";
import { requirePlan } from "./plan";

/**
 * Reader groups (Settings → Groups): who's in one is worked out when they read: the project's users
 * whose properties (lib/user-properties.ts) match all of the group's conditions (lib/group-conditions.ts). Docs tabs, collections and articles can be for some groups only
 * (tabs.*, collections.*, articles.*, see lib/read-access.ts), named by the group's `key`.
 */

const groupFields = {
  name: z.string().trim().min(1, "Name is required").max(50),
  description: z.string().trim().max(300),
  /** At least one: a group without any would have nobody in it. */
  conditions: groupConditions.min(1, "A group needs a condition"),
};

export type GroupView = {
  key: string;
  name: string;
  description: string;
  conditions: GroupCondition[];
  /** How many of the project's users are in it now, and the names of the first 3. */
  readers: number;
  sample: string[];
};

/** How many of the project's users a group with these conditions has now, and the first `limit` of them by name. */
export async function matchingUsers(projectId: string, conditions: GroupCondition[], limit: number) {
  const where = Prisma.sql`s."projectId" = ${projectId} AND ${inGroupSql(conditions, Prisma.sql`s`)}`;
  // One pass: the count is of every match, before the limit.
  const rows = await prisma.$queryRaw<{ id: string; name: string; email: string | null; avatar: string | null; count: bigint }[]>`
    SELECT s."externalId" AS id, u.name, s.email, u.image AS avatar, count(*) OVER () AS count
    FROM sso_identity s JOIN "user" u ON u.id = s."userId"
    WHERE ${where} ORDER BY u.name, s.id LIMIT ${limit}`;
  return { readers: Number(rows[0]?.count ?? 0), users: rows.map((row) => ({ id: row.id, name: row.name, email: row.email, avatar: row.avatar })) };
}

/** How many of the project's users a group with these conditions has now, and the first 3's names. */
export async function whoMatches(projectId: string, conditions: GroupCondition[]) {
  const { readers, users } = await matchingUsers(projectId, conditions, 3);
  return { readers, sample: users.map((user) => user.name) };
}

/** Of `names`, in their order, those some user of the project has, however many other properties there are. */
export async function propertiesInUse(projectId: string, names: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT c.name FROM unnest(${names}::text[]) WITH ORDINALITY AS c(name, i)
    WHERE EXISTS (SELECT 1 FROM sso_identity s WHERE s."projectId" = ${projectId} AND jsonb_exists(s.attributes, c.name))
    ORDER BY c.i`;
  return rows.map((row) => row.name);
}

/** The names of the properties the project's users have (up to 200), for suggestions. */
export async function propertyNames(projectId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT jsonb_object_keys(attributes) AS name FROM sso_identity WHERE "projectId" = ${projectId} ORDER BY name LIMIT 200`;
  return rows.map((row) => row.name);
}

/**
 * How many number properties Who's asking offers: far past what a team picks from, while an app that
 * names one per user (`usage_<id>`) can't make the page send and draw them all. ponytail: a search box
 * that asks the server if a project needs more.
 */
export const NUMBER_PROPERTIES = 1000;

/** The names of the project's users' number properties (Who's asking totals one), A to Z. */
export async function numberPropertyNames(projectId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT p.key AS name FROM sso_identity s, jsonb_each(s.attributes) p
    WHERE s."projectId" = ${projectId} AND jsonb_typeof(p.value) = 'number' ORDER BY name LIMIT ${NUMBER_PROPERTIES}`;
  return rows.map((row) => row.name);
}

/** The project's groups by name, each with who's in it now (or just group `key`). */
export async function groupsWithReaders(projectId: string, key?: string): Promise<GroupView[]> {
  const groups = await prisma.readerGroup.findMany({
    where: { projectId, ...(key !== undefined && { key }) },
    orderBy: [{ name: "asc" }, { key: "asc" }],
    select: { key: true, name: true, description: true, conditions: true },
  });
  return Promise.all(
    groups.map(async (group) => {
      const conditions = storedConditions(group.conditions);
      return { ...group, conditions, ...(await whoMatches(projectId, conditions)) };
    }),
  );
}

const viewOf = async (projectId: string, key: string) => (await groupsWithReaders(projectId, key))[0]!;

const notFound = (key: string) => new OperationError(404, "not_found", `There's no group “${key}”`);

export const listGroups = defineOperation({
  name: "groups.list",
  summary:
    "List the reader groups by name, each with its `key` (how tabs.*, collections.*, articles.* and these paths name it): one of your app's users is in one when their properties match all of its `conditions`; `readers` counts them now and `sample` names up to 3. Tabs, collections and articles can be for some groups only (`access` groups, with `groups`, on tabs.*, collections.* and articles.*)",
  method: "GET",
  path: "/groups",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({ groups: await groupsWithReaders(projectId) }),
});

export const createGroup = defineOperation({
  name: "groups.create",
  summary:
    "Add a reader group: its name (its `key` comes from it and never changes), an optional description and who's in it: `conditions` on your users' properties (set by SSO tokens' `properties` and users.sync; up to 10, all must match), each a `property`, an `op` and a `value`: `is`, `is_not`, `contains` or `excludes` a text; `is_any_of` or `is_none_of` a list; `is_set` and `is_not_set` take none. Values compare as text, exactly; a list property matches when one of its items does (or, for the negative ones, none does), and a missing one matches only the negative ones and `is_not_set`. An SSO token's `groups` is the `groups` property, e.g. `{ \"property\": \"groups\", \"op\": \"is\", \"value\": \"beta\" }`",
  method: "POST",
  path: "/groups",
  scope: "write",
  access: "admin",
  input: z.object({
    name: groupFields.name,
    description: groupFields.description.default(""),
    conditions: groupFields.conditions,
  }),
  example: { name: "Pro customers", conditions: [{ property: "plan", op: "is_any_of", value: ["pro", "enterprise"] }, { property: "support_tier", op: "is_set" }] },
  run: async ({ projectId }, { name, description, conditions }) => {
    await requirePlan(projectId, "privatePortal");
    // Locked, so two groups with the same name get "pro" and "pro-2".
    const key = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const base = titleSlug(name, "group").slice(0, 45).replace(/-+$/, "");
      const keys = await tx.readerGroup.findMany({ where: { projectId, key: { startsWith: base } }, select: { key: true } });
      const used = new Set(keys.map((group) => group.key));
      let candidate = base;
      for (let n = 2; used.has(candidate); n++) {
        candidate = `${base}-${n}`;
      }
      await tx.readerGroup.create({ data: { projectId, key: candidate, name, description, conditions } });
      return candidate;
    });
    return viewOf(projectId, key);
  },
});

export const updateGroup = defineOperation({
  name: "groups.update",
  summary:
    "Change a reader group (`group` is its key, which stays): its name, description or `conditions` (all of them, at least one). Then it's whichever of your users match them, and the tabs, collections and articles for it follow",
  method: "PATCH",
  path: "/groups/{group}",
  scope: "write",
  access: "admin",
  input: z.object({
    group: readerGroup,
    name: groupFields.name.optional(),
    description: groupFields.description.optional(),
    conditions: groupFields.conditions.optional(),
  }),
  example: { name: "Enterprise customers", conditions: [{ property: "plan", op: "is", value: "enterprise" }] },
  run: async ({ projectId }, { group, ...input }) => {
    await requirePlan(projectId, "privatePortal");
    // Its conditions say who's in it now, not a claim from before (see ReaderGroup.legacyClaim).
    const data = { ...input, ...(input.conditions && { legacyClaim: null }) };
    const { count } = await prisma.readerGroup.updateMany({ where: { projectId, key: group }, data });
    if (count === 0) {
      throw notFound(group);
    }
    return viewOf(projectId, group);
  },
});

export const deleteGroup = defineOperation({
  name: "groups.delete",
  summary:
    "Delete a reader group (by key). One a tab, collection or article is for is refused (409): taking it away would change who can read them, so remove it from them first. Deleted articles let it go",
  method: "DELETE",
  path: "/groups/{group}",
  scope: "write",
  access: "admin",
  input: z.object({ group: readerGroup }),
  run: async ({ projectId }, input) => {
    // Locked, so a tab, collection or article being saved with it lands first (and is named here) or finds it gone.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const group = await tx.readerGroup.findUnique({
        where: { projectId_key: { projectId, key: input.group } },
        select: {
          id: true,
          tabs: { select: { tab: { select: { name: true } } }, orderBy: { tab: { name: "asc" } } },
          collections: { select: { collection: { select: { name: true } } }, orderBy: { collection: { name: "asc" } } },
          articles: { where: { article: { deletedAt: null } }, select: { article: { select: { title: true } } }, orderBy: { article: { title: "asc" } } },
        },
      });
      if (!group) {
        throw notFound(input.group);
      }
      const users = [...group.tabs.map((t) => t.tab.name), ...group.collections.map((c) => c.collection.name), ...group.articles.map((a) => a.article.title)];
      if (users.length > 0) {
        throw new OperationError(409, "conflict", `Used by ${new Intl.ListFormat("en-GB").format(users)}; remove it from them first`);
      }
      // A deleted article restored later is for none of its groups then: only the team, until it's given others.
      await tx.articleGroup.deleteMany({ where: { groupId: group.id } });
      await tx.readerGroup.delete({ where: { id: group.id } });
    });
    return { deleted: input.group };
  },
});
