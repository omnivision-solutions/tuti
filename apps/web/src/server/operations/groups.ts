import { Prisma, prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { z } from "zod";

import { titleSlug } from "@/lib/post-urls";
import { readerGroup } from "@/lib/reader-groups";

import { defineOperation, OperationError } from "./define";

/**
 * Reader groups (Settings → Groups): who's in one is worked out when they read, from their latest
 * SSO sign-in's `groups` claim naming the group's `claim`. Docs collections can be for some groups
 * only (collections.*, see lib/reader-groups.ts), named by the group's `key`.
 */

const groupFields = {
  name: z.string().trim().min(1, "Name is required").max(50),
  /** What the SSO token's `groups` says for people in it; changing it changes who's in it. */
  claim: readerGroup,
  description: z.string().trim().max(300),
};

export type GroupView = { key: string; name: string; claim: string | null; description: string; readers: number };

/** The project's groups by name, each with how many people its SSO signed in are in it now (or just group `key`). */
export async function groupsWithReaders(projectId: string, key?: string) {
  return prisma.$queryRaw<GroupView[]>`
    SELECT rg.key, rg.name, rg.claim, rg.description, count(s.id)::int AS readers
    FROM reader_group rg
    LEFT JOIN sso_identity s ON s."projectId" = rg."projectId" AND rg.claim = ANY(s.groups)
    WHERE rg."projectId" = ${projectId} ${key === undefined ? Prisma.empty : Prisma.sql`AND rg.key = ${key}`}
    GROUP BY rg.id
    ORDER BY rg.name, rg.key`;
}

const viewOf = async (projectId: string, key: string) => (await groupsWithReaders(projectId, key))[0]!;

const taken = (error: unknown, claim: string) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    ? new OperationError(409, "conflict", `There's already a group “${claim}”`)
    : error;

const notFound = (key: string) => new OperationError(404, "not_found", `There's no group “${key}”`);

export const listGroups = defineOperation({
  name: "groups.list",
  summary:
    "List the reader groups by name: who's in one is whoever your app's SSO last signed in with its `claim` in the token's `groups`; `readers` counts them now. Collections can be for some groups only (`groups` on collections.*, by `key`)",
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
    "Add a reader group: its name, the `claim` your app's SSO token names it by in `groups` (lowercase letters, digits and - _ . :; left out, from the name) and an optional description",
  method: "POST",
  path: "/groups",
  scope: "write",
  access: "admin",
  input: z.object({ ...groupFields, claim: groupFields.claim.optional(), description: groupFields.description.default("") }),
  example: { name: "Enterprise", claim: "enterprise", description: "Customers on the Enterprise plan" },
  run: async ({ projectId }, input) => {
    const claim = input.claim ?? titleSlug(input.name, "group");
    try {
      await prisma.readerGroup.create({ data: { projectId, key: claim, name: input.name, claim, description: input.description } });
    } catch (error) {
      throw taken(error, claim);
    }
    return viewOf(projectId, claim);
  },
});

export const updateGroup = defineOperation({
  name: "groups.update",
  summary:
    "Rename a reader group (`group` is its key), change its description or its `claim`: then it's whoever your app's SSO signs in with the new claim, and the collections for it follow",
  method: "PATCH",
  path: "/groups/{group}",
  scope: "write",
  access: "admin",
  input: z.object({
    group: readerGroup,
    name: groupFields.name.optional(),
    claim: groupFields.claim.optional(),
    description: groupFields.description.optional(),
  }),
  example: { name: "Enterprise customers" },
  run: async ({ projectId }, { group, ...input }) => {
    try {
      const { count } = await prisma.readerGroup.updateMany({ where: { projectId, key: group }, data: input });
      if (count === 0) {
        throw notFound(group);
      }
    } catch (error) {
      throw taken(error, input.claim ?? group);
    }
    return viewOf(projectId, group);
  },
});

export const deleteGroup = defineOperation({
  name: "groups.delete",
  summary:
    "Delete a reader group. One a collection is for is refused (409): taking it away would open the collection to everyone, so remove it from them first",
  method: "DELETE",
  path: "/groups/{group}",
  scope: "write",
  access: "admin",
  input: z.object({ group: readerGroup }),
  run: async ({ projectId }, input) => {
    // Locked, so a collection being saved with it lands first (and is named here) or finds it gone.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const group = await tx.readerGroup.findUnique({
        where: { projectId_key: { projectId, key: input.group } },
        select: { id: true, collections: { select: { collection: { select: { name: true } } }, orderBy: { collection: { name: "asc" } } } },
      });
      if (!group) {
        throw notFound(input.group);
      }
      if (group.collections.length > 0) {
        const names = new Intl.ListFormat("en-GB").format(group.collections.map((c) => c.collection.name));
        throw new OperationError(409, "conflict", `Used by ${names}; remove it from them first`);
      }
      await tx.readerGroup.delete({ where: { id: group.id } });
    });
    return { deleted: input.group };
  },
});
