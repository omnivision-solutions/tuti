import { Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { pictureUrl } from "@tuti/shared/media-links";
import { z } from "zod";

import { type GroupCondition, groupConditions, groupMatch, type GroupRule, type Match, OPERATORS, storedRule } from "@/lib/group-conditions";
import { titleSlug } from "@/lib/post-urls";
import { readerGroup } from "@/lib/reader-groups";

import { inGroupSql } from "../group-conditions-sql";
import { defineOperation, OperationError } from "./define";
import { requirePlan } from "./plan";

/**
 * Reader groups (Settings → Groups): who's in one is worked out when they read: the project's users
 * whose properties (@tuti/shared/user-properties) match all of the group's conditions, or any one (its `match`) (lib/group-conditions.ts). Docs tabs, collections and articles can be for some groups only
 * (tabs.*, collections.*, articles.*, see lib/read-access.ts), named by the group's `key`.
 */

const groupFields = {
  name: z.string().trim().min(1, "Name is required").max(50),
  description: z.string().trim().max(300).describe("What it's for, for the team"),
  /** At least one: a group without any would have nobody in it. */
  conditions: groupConditions
    .min(1, "A group needs a condition")
    .describe(
      "Who's in it: conditions on your users' properties (set by SSO tokens' `properties` and users.sync), at least one and up to 10. Values compare as text, exactly; a list property matches when one of its items does (for the negative ones, when none does), and a missing one matches only the negative ones and `is_not_set`. An SSO token's `groups` is the `groups` property: `{ \"property\": \"groups\", \"op\": \"is\", \"value\": \"beta\" }`",
    ),
  match: groupMatch.describe("`all` needs every condition to match a user, `any` one of them"),
};

/** A group as the API returns it (GroupView). */
const groupOutput = z
  .object({
    key: z
      .string()
      .describe("Its key: from its name when made, it never changes, and names it in these paths and on tabs, collections and articles (`groups`)")
      .meta({ examples: ["pro-customers"] }),
    name: z.string().describe("Its name").meta({ examples: ["Pro customers"] }),
    description: z.string().describe("What it's for, for the team; empty if none").meta({ examples: ["Customers on a paid plan"] }),
    conditions: z
      .array(
        z
          .object({
            property: z.string().describe("The user property it looks at, by name").meta({ examples: ["plan"] }),
            op: z
              .enum(Object.keys(OPERATORS) as [keyof typeof OPERATORS, ...(keyof typeof OPERATORS)[]])
              .describe("How it compares the property with `value`")
              .meta({ examples: ["is_any_of"] }),
            value: z
              .union([z.string(), z.array(z.string())])
              .optional()
              .describe("The text it compares with, or a list for `is_any_of` and `is_none_of`; none for `is_set` and `is_not_set`")
              .meta({ examples: [["pro", "enterprise"]] }),
          })
          .meta({ id: "GroupCondition", description: "A condition on a user's properties" }),
      )
      .describe("Who's in it: one of your app's users is when their properties match all of these, or any one (`match`)"),
    match: groupMatch.describe("`all` of the conditions must match, or `any` one").meta({ examples: ["all"] }),
    readers: z.number().int().describe("How many of your users are in it now").meta({ examples: [42] }),
    sample: z.array(z.string().meta({ examples: ["Sam from Acme"] })).describe("The names of the first 3 of them, by name"),
  })
  .meta({ id: "ReaderGroup", description: "A reader group: who's in it is worked out from your users' properties when they read" });

export type GroupView = {
  key: string;
  name: string;
  description: string;
  conditions: GroupCondition[];
  match: Match;
  /** How many of the project's users are in it now, and the names of the first 3. */
  readers: number;
  sample: string[];
};

/** How many of the project's users a group with this rule has now, and the first `limit` of them by name. */
export async function matchingUsers(projectId: string, rule: GroupRule, limit: number) {
  const where = Prisma.sql`s."projectId" = ${projectId} AND ${inGroupSql(rule, Prisma.sql`s`)}`;
  // One pass: the count is of every match, before the limit.
  const rows = await prisma.$queryRaw<{ id: string; name: string; email: string | null; avatar: string | null; count: bigint }[]>`
    SELECT s."externalId" AS id, u.name, s.email, u.image AS avatar, count(*) OVER () AS count
    FROM sso_identity s JOIN "user" u ON u.id = s."userId"
    WHERE ${where} ORDER BY u.name, s.id LIMIT ${limit}`;
  return { readers: Number(rows[0]?.count ?? 0), users: rows.map((row) => ({ id: row.id, name: row.name, email: row.email, avatar: pictureUrl(row.avatar) })) };
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

/** How many values the group dialog suggests for a property. */
export const PROPERTY_VALUES = 50;

/**
 * The values the project's users have for property `name` (a list's items each), the most common first, as conditions
 * compare them (text, as conditionsSql has them). One pass over the project's users: about 50ms for 100k+.
 */
export async function propertyValues(projectId: string, name: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ value: string }[]>`
    SELECT v.value FROM sso_identity s
    CROSS JOIN LATERAL unnest(CASE WHEN jsonb_typeof(s.attributes -> ${name}::text) = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(s.attributes -> ${name}::text)) ELSE ARRAY[s.attributes ->> ${name}::text] END) AS v(value)
    WHERE s."projectId" = ${projectId} AND jsonb_exists(s.attributes, ${name}::text)
    GROUP BY v.value ORDER BY count(*) DESC, v.value LIMIT ${PROPERTY_VALUES}`;
  return rows.map((row) => row.value);
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
    select: { key: true, name: true, description: true, conditions: true, match: true },
  });
  return Promise.all(
    groups.map(async (group) => {
      const rule = storedRule(group);
      // Who's in it now: how many, and the first 3's names.
      const { readers, users } = await matchingUsers(projectId, rule, 3);
      return { ...group, ...rule, readers, sample: users.map((user) => user.name) };
    }),
  );
}

const viewOf = async (projectId: string, key: string) => (await groupsWithReaders(projectId, key))[0]!;

const notFound = (key: string) => new OperationError(404, "not_found", `There's no group “${key}”`);

export const listGroups = defineOperation({
  name: "groups.list",
  title: "List reader groups",
  summary:
    "List the reader groups by name, with who's in each now (`readers` counts them, `sample` names up to 3). Tabs, collections and articles can be for some groups only (`access` groups, with `groups` naming them by key).",
  method: "GET",
  path: "/groups",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z.object({ groups: z.array(groupOutput).describe("The project's reader groups, by name") }).describe("The reader groups"),
  run: async ({ projectId }) => ({ groups: await groupsWithReaders(projectId) }),
});

export const createGroup = defineOperation({
  name: "groups.create",
  title: "Create a reader group",
  summary: "Add a reader group: who's in it is worked out from your users' properties each time they read, by its `conditions`.",
  method: "POST",
  path: "/groups",
  scope: "write",
  access: "admin",
  errors: [402],
  input: z.object({
    name: groupFields.name.describe("Its name; its `key` comes from it and never changes"),
    description: groupFields.description.default("").describe("An optional description, what it's for, for the team"),
    conditions: groupFields.conditions,
    match: groupFields.match.default("all").describe("`all` (the default) needs every condition to match a user, `any` one of them"),
  }),
  output: groupOutput.describe("The new group, with who's in it now"),
  example: { name: "Pro customers", conditions: [{ property: "plan", op: "is_any_of", value: ["pro", "enterprise"] }, { property: "support_tier", op: "is_set" }] },
  run: async ({ projectId }, { name, description, conditions, match }) => {
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
      await tx.readerGroup.create({ data: { projectId, key: candidate, name, description, conditions, match } });
      return candidate;
    });
    return viewOf(projectId, key);
  },
});

export const updateGroup = defineOperation({
  name: "groups.update",
  title: "Update a reader group",
  summary:
    "Change a reader group; what's left out stays. Then it's whichever of your users match its conditions, and the tabs, collections and articles for it follow.",
  method: "PATCH",
  path: "/groups/{group}",
  scope: "write",
  access: "admin",
  errors: [402],
  input: z.object({
    group: readerGroup.describe("The group's key, which stays"),
    name: groupFields.name.optional().describe("Its name"),
    description: groupFields.description.optional(),
    conditions: groupFields.conditions.optional().describe("All of its conditions, at least one, in place of those it has (see groups.create)"),
    match: groupFields.match.optional(),
  }),
  output: groupOutput.describe("The group, with who's in it now"),
  example: { name: "Enterprise customers", conditions: [{ property: "plan", op: "is", value: "enterprise" }] },
  run: async ({ projectId }, { group, ...input }) => {
    await requirePlan(projectId, "privatePortal");
    // Its conditions say who's in it now, not a claim from before (see ReaderGroup.legacyClaim).
    const data = { ...input, ...((input.conditions || input.match) && { legacyClaim: null }) };
    const { count } = await prisma.readerGroup.updateMany({ where: { projectId, key: group }, data });
    if (count === 0) {
      throw notFound(group);
    }
    return viewOf(projectId, group);
  },
});

export const deleteGroup = defineOperation({
  name: "groups.delete",
  title: "Delete a reader group",
  summary:
    "Delete a reader group. One a tab, collection, article or changelog entry is for is refused (409): taking it away would change who can read them, so remove it from them first. Deleted articles let it go.",
  method: "DELETE",
  path: "/groups/{group}",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({ group: readerGroup.describe("The group's key") }),
  output: z.object({ deleted: z.string().describe("The deleted group's key").meta({ examples: ["beta"] }) }).describe("The group is gone"),
  run: async ({ projectId }, input) => {
    // Locked, so a tab, collection, article or changelog entry being saved with it lands first (and is named here) or finds it gone.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const group = await tx.readerGroup.findUnique({
        where: { projectId_key: { projectId, key: input.group } },
        select: {
          id: true,
          tabs: { select: { tab: { select: { name: true } } }, orderBy: { tab: { name: "asc" } } },
          collections: { select: { collection: { select: { name: true } } }, orderBy: { collection: { name: "asc" } } },
          articles: { where: { article: { deletedAt: null } }, select: { article: { select: { title: true } } }, orderBy: { article: { title: "asc" } } },
          changelogEntries: { select: { entry: { select: { title: true } } }, orderBy: { entry: { number: "asc" } } },
        },
      });
      if (!group) {
        throw notFound(input.group);
      }
      const users = [...group.tabs.map((t) => t.tab.name), ...group.collections.map((c) => c.collection.name), ...group.articles.map((a) => a.article.title), ...group.changelogEntries.map((e) => e.entry.title)];
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
