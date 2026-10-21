import { Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { z } from "zod";

import { type GroupCondition, groupConditions, type GroupRules, inGroup, readerAttributes, storedConditions } from "@/lib/group-conditions";
import { titleSlug } from "@/lib/post-urls";
import { readerGroup } from "@/lib/reader-groups";

import { defineOperation, OperationError } from "./define";

/**
 * Reader groups (Settings → Groups): who's in one is worked out when they read, from their latest
 * SSO sign-in: its `groups` claim naming the group's `claim`, or its `attributes` matching all of the
 * group's conditions (lib/group-conditions.ts). Docs tabs, collections and articles can be for some groups only
 * (tabs.*, collections.*, articles.*, see lib/read-access.ts), named by the group's `key`.
 */

const groupFields = {
  name: z.string().trim().min(1, "Name is required").max(50),
  /** What the SSO token's `groups` says for people in it; changing it changes who's in it. */
  claim: readerGroup.nullable(),
  description: z.string().trim().max(300),
  conditions: groupConditions,
};

export type GroupView = {
  key: string;
  name: string;
  claim: string | null;
  description: string;
  conditions: GroupCondition[];
  /** How many of the project's SSO users are in it now, and the names of the first 3. */
  readers: number;
  sample: string[];
};

/**
 * The project's SSO users as their latest sign-in left them, by name.
 * ponytail: all of a project's SSO users, matched here; at thousands per project, count in SQL (jsonb) instead.
 */
export async function ssoReaders(projectId: string) {
  const identities = await prisma.ssoIdentity.findMany({
    where: { projectId },
    select: { groups: true, attributes: true, user: { select: { name: true } } },
    orderBy: [{ user: { name: "asc" } }, { id: "asc" }],
  });
  return identities.map((identity) => ({ name: identity.user.name, groups: identity.groups, attributes: readerAttributes(identity.attributes) }));
}

/** How many of `readers` a group with these rules has, and the first 3's names. */
export function whoMatches(rules: GroupRules, readers: Awaited<ReturnType<typeof ssoReaders>>) {
  const matching = readers.filter((reader) => inGroup(rules, reader));
  return { readers: matching.length, sample: matching.slice(0, 3).map((reader) => reader.name) };
}

/** The project's groups by name, each with who's in it now (or just group `key`). */
export async function groupsWithReaders(projectId: string, key?: string): Promise<GroupView[]> {
  const [groups, readers] = await Promise.all([
    prisma.readerGroup.findMany({
      where: { projectId, ...(key !== undefined && { key }) },
      orderBy: [{ name: "asc" }, { key: "asc" }],
      select: { key: true, name: true, claim: true, description: true, conditions: true },
    }),
    ssoReaders(projectId),
  ]);
  return groups.map((group) => {
    const conditions = storedConditions(group.conditions);
    return { ...group, conditions, ...whoMatches({ claim: group.claim, conditions }, readers) };
  });
}

const viewOf = async (projectId: string, key: string) => (await groupsWithReaders(projectId, key))[0]!;

/** A group with neither would have nobody in it. */
function needsRules(claim: string | null, conditions: GroupCondition[]) {
  if (claim === null && conditions.length === 0) {
    throw new OperationError(400, "invalid_input", "A group needs an SSO group name or a condition");
  }
}

const taken = (error: unknown, claim: string | null | undefined) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    ? new OperationError(409, "conflict", `There's already a group “${claim}”`)
    : error;

const notFound = (key: string) => new OperationError(404, "not_found", `There's no group “${key}”`);

export const listGroups = defineOperation({
  name: "groups.list",
  summary:
    "List the reader groups by name, each with its `key` (how tabs.*, collections.*, articles.* and these paths name it): someone your app's SSO signed in is in one when their latest token's `groups` has its `claim`, or its `attributes` match all of its `conditions`; `readers` counts them now and `sample` names up to 3. Tabs, collections and articles can be for some groups only (`access` groups, with `groups`, on tabs.*, collections.* and articles.*)",
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
    "Add a reader group: its name (its `key` comes from it and never changes), an optional description and who's in it: the `claim` your app's SSO token names it by in `groups` (lowercase letters, digits and - _ . :), `conditions` on the token's `attributes` (up to 10, all must match: `is`, `is_not` or `is_one_of` a list; values compare as text, exactly), or both (either lets them in). It needs a claim or a condition",
  method: "POST",
  path: "/groups",
  scope: "write",
  access: "admin",
  input: z.object({
    name: groupFields.name,
    claim: groupFields.claim.default(null),
    description: groupFields.description.default(""),
    conditions: groupFields.conditions.default([]),
  }),
  example: { name: "Pro customers", conditions: [{ attribute: "plan", op: "is_one_of", value: ["pro", "enterprise"] }] },
  run: async ({ projectId }, { name, claim, description, conditions }) => {
    needsRules(claim, conditions);
    // Locked, so two groups with the same name get "pro" and "pro-2".
    const key = await prisma
      .$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const base = titleSlug(name, "group").slice(0, 45).replace(/-+$/, "");
        const keys = await tx.readerGroup.findMany({ where: { projectId, key: { startsWith: base } }, select: { key: true } });
        const used = new Set(keys.map((group) => group.key));
        let candidate = base;
        for (let n = 2; used.has(candidate); n++) {
          candidate = `${base}-${n}`;
        }
        await tx.readerGroup.create({ data: { projectId, key: candidate, name, claim, description, conditions } });
        return candidate;
      })
      .catch((error: unknown) => {
        throw taken(error, claim);
      });
    return viewOf(projectId, key);
  },
});

export const updateGroup = defineOperation({
  name: "groups.update",
  summary:
    "Change a reader group (`group` is its key, which stays): its name, description, `claim` (null for none) or `conditions` (all of them; [] for none). Then it's whoever your app's SSO signs in with the claim or matching the conditions, and the tabs, collections and articles for it follow. It keeps a claim or a condition",
  method: "PATCH",
  path: "/groups/{group}",
  scope: "write",
  access: "admin",
  input: z.object({
    group: readerGroup,
    name: groupFields.name.optional(),
    claim: groupFields.claim.optional(),
    description: groupFields.description.optional(),
    conditions: groupFields.conditions.optional(),
  }),
  example: { name: "Enterprise customers", conditions: [{ attribute: "plan", op: "is", value: "enterprise" }] },
  run: async ({ projectId }, { group, ...input }) => {
    // Locked, so two changes at once can't leave it with neither a claim nor a condition.
    await prisma
      .$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const current = await tx.readerGroup.findUnique({ where: { projectId_key: { projectId, key: group } }, select: { id: true, claim: true, conditions: true } });
        if (!current) {
          throw notFound(group);
        }
        needsRules(input.claim !== undefined ? input.claim : current.claim, input.conditions ?? storedConditions(current.conditions));
        await tx.readerGroup.update({ where: { id: current.id }, data: input });
      })
      .catch((error: unknown) => {
        throw taken(error, input.claim);
      });
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
