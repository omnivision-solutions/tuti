import { prisma } from "@tuti/db";
import { z } from "zod";

import { inGroup, storedConditions } from "@/lib/group-conditions";
import { MAX_PROPERTIES, type Properties, propertyChangesInput, storedProperties } from "@/lib/user-properties";

import { syncUsers } from "../project-users";
import { defineOperation, OperationError } from "./define";

/**
 * The project's users (server/project-users.ts): the people its app tells Tuti about, with the
 * properties reader groups' conditions match. users.sync is how a team's app (or its AI agent) sends them.
 */

export const MAX_USERS_PER_SYNC = 1000;

const userId = z.string().min(1).max(255);

export type UserView = {
  /** Their id in the project's app. */
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  properties: Properties;
  /** The keys of the reader groups they're in now. */
  groups: string[];
  createdAt: Date;
  updatedAt: Date;
};

const userSelect = {
  externalId: true,
  email: true,
  groups: true,
  properties: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { name: true, image: true } },
} as const;

/** The project's users as views, with the groups each is in. */
async function viewsOf(projectId: string, users: { externalId: string; email: string | null; groups: string[]; properties: unknown; createdAt: Date; updatedAt: Date; user: { name: string; image: string | null } }[]) {
  const groups = await prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, claim: true, conditions: true }, orderBy: { key: "asc" } });
  const rules = groups.map((group) => ({ key: group.key, claim: group.claim, conditions: storedConditions(group.conditions) }));
  return users.map((user): UserView => {
    const properties = storedProperties(user.properties);
    return {
      id: user.externalId,
      name: user.user.name,
      email: user.email,
      avatar: user.user.image,
      properties,
      groups: rules.filter((rule) => inGroup(rule, { groups: user.groups, properties })).map((rule) => rule.key),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  });
}

export const listUsers = defineOperation({
  name: "users.list",
  summary:
    "List the project's users (the people your app signs in or sends with users.sync) by name, each with their `id` in your app, email, properties and the reader groups they're in now; `q` finds them by name, email or id",
  method: "GET",
  path: "/users",
  scope: "read",
  access: "team",
  input: z.object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  example: { q: "acme.com", limit: 20 },
  run: async ({ projectId }, input) => {
    const q = input.q || undefined;
    // ponytail: offset cursors, like posts.list; switch to keyset pagination if projects get very large.
    const users = await prisma.ssoIdentity.findMany({
      where: {
        projectId,
        ...(q && {
          OR: [
            { externalId: q },
            { email: { contains: q, mode: "insensitive" as const } },
            { user: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }),
      },
      select: userSelect,
      orderBy: [{ user: { name: "asc" } }, { externalId: "asc" }],
      skip: input.cursor,
      take: input.limit + 1,
    });
    return {
      users: await viewsOf(projectId, users.slice(0, input.limit)),
      nextCursor: users.length > input.limit ? String(input.cursor + input.limit) : null,
    };
  },
});

export const getUser = defineOperation({
  name: "users.get",
  summary: "One of the project's users, by their id in your app: name, email, properties and the reader groups they're in now",
  method: "GET",
  path: "/users/{user}",
  scope: "read",
  access: "team",
  input: z.object({ user: userId }),
  run: async ({ projectId }, input) => {
    const user = await prisma.ssoIdentity.findUnique({ where: { projectId_externalId: { projectId, externalId: input.user } }, select: userSelect });
    if (!user) {
      throw new OperationError(404, "not_found", `There's no user “${input.user}”`);
    }
    return (await viewsOf(projectId, [user]))[0]!;
  },
});

const userInput = z.object({
  id: userId,
  name: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(320).nullable().optional(),
  avatar: z.url({ protocol: /^https?$/ }).max(2048).nullable().optional(),
  properties: propertyChangesInput.optional(),
});

export const syncUsersOperation = defineOperation({
  name: "users.sync",
  summary: `Add or change the project's users, up to ${MAX_USERS_PER_SYNC} at once, each by their \`id\` in your app (the \`sub\` of your SSO tokens): their name, email, avatar and properties, which reader groups' conditions match. Only what's given changes; \`properties\` sets the ones it names (strings, numbers, booleans or lists of strings) and removes the ones that are null, keeping the rest, up to ${MAX_PROPERTIES} per user. Someone signed in to your portal with a verified address is in the groups of the users with that email. All or nothing; \`created\` and \`updated\` say how many`,
  method: "POST",
  path: "/users",
  scope: "write",
  access: "admin",
  input: z.object({
    users: z
      .array(userInput)
      .min(1, "Send at least one user")
      .max(MAX_USERS_PER_SYNC, `Up to ${MAX_USERS_PER_SYNC} users at once`)
      .refine((users) => new Set(users.map((user) => user.id)).size === users.length, "Each user once"),
  }),
  example: {
    users: [{ id: "user-42", name: "Sam from Acme", email: "e2e-sam@example.com", properties: { plan: "enterprise", seats: 40, features: ["sso"], trial: null } }],
  },
  run: async ({ projectId }, input) => {
    const { created } = await syncUsers(
      projectId,
      input.users.map((user) => ({ externalId: user.id, name: user.name, image: user.avatar, email: user.email, properties: user.properties })),
      { strict: true },
    );
    return { created, updated: input.users.length - created };
  },
});
