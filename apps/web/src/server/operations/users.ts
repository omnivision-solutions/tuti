import { Prisma, prisma } from "@tuti/db";
import { z } from "zod";

import { inGroup, storedConditions } from "@/lib/group-conditions";
import { readerGroup } from "@/lib/reader-groups";
import { MAX_PROPERTIES, type Properties, propertyChangesInput, storedProperties } from "@/lib/user-properties";

import { inGroupSql } from "../group-conditions-sql";
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

/** What someone did on the project's portal and widget: posts (not merged), votes, conversations (not spam), and when they were last seen there. */
export type UserActivity = { posts: number; votes: number; conversations: number; lastSeenAt: Date | null };

export const USER_SORTS = ["name", "posts", "votes", "conversations", "lastSeen"] as const;

/**
 * Who a user (`s`, their identity) is on the portal and in the widget, as `who.ids`: the account their app signs them
 * in as, and the accounts with their address once it's verified (as Who's asking and groups count them, voterIdentities
 * in server/post-lists.ts), never the team's.
 */
const accountsOf = Prisma.sql`CROSS JOIN LATERAL (
  SELECT array_agg(o.id) AS ids FROM "user" o
  WHERE o.id = s."userId"
    OR (s.email IS NOT NULL AND o."emailVerified" AND lower(o.email) = s.email
      AND NOT EXISTS (SELECT 1 FROM team_member t WHERE t."projectId" = s."projectId" AND t."userId" = o.id))
) who`;

/**
 * A user's activity, as SQL over their identity `s` and accounts `who` (accountsOf). Last seen is the latest of their
 * time in the widget, their posts, votes and comments, and their messages in conversations: what Tuti sees of them.
 * ponytail: worked out per user, for every user an activity sort matches; keep a summary per user if projects outgrow it.
 */
const activitySql = {
  posts: Prisma.sql`(SELECT count(*) FROM post p WHERE p."projectId" = s."projectId" AND p."authorId" = ANY(who.ids) AND p."duplicateOfId" IS NULL)::int`,
  votes: Prisma.sql`(SELECT count(*) FROM vote v WHERE v."projectId" = s."projectId" AND v."userId" = ANY(who.ids))::int`,
  conversations: Prisma.sql`(SELECT count(*) FROM conversation c WHERE c."projectId" = s."projectId" AND c."userId" = ANY(who.ids) AND NOT c.spam)::int`,
  lastSeen: Prisma.sql`GREATEST(
    (SELECT max(w."lastSeenAt") FROM widget_presence w WHERE w."projectId" = s."projectId" AND w.who = ANY(who.ids)),
    (SELECT max(p."createdAt") FROM post p WHERE p."projectId" = s."projectId" AND p."authorId" = ANY(who.ids)),
    (SELECT max(v."createdAt") FROM vote v WHERE v."projectId" = s."projectId" AND v."userId" = ANY(who.ids)),
    (SELECT max(m."createdAt") FROM comment m WHERE m."projectId" = s."projectId" AND m."authorId" = ANY(who.ids)),
    (SELECT max(cm."createdAt") FROM conversation_message cm JOIN conversation c ON c.id = cm."conversationId"
      WHERE c."projectId" = s."projectId" AND c."userId" = ANY(who.ids) AND cm.author = 'USER'))`,
};

const userSelect = {
  externalId: true,
  email: true,
  properties: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { name: true, image: true } },
} as const;

/** The project's users as views, with the groups each is in (also the inbox's panel beside a conversation). */
export async function viewsOf(projectId: string, users: { externalId: string; email: string | null; properties: unknown; createdAt: Date; updatedAt: Date; user: { name: string; image: string | null } }[]) {
  const groups = await prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, conditions: true }, orderBy: { key: "asc" } });
  const rules = groups.map((group) => ({ key: group.key, conditions: storedConditions(group.conditions) }));
  return users.map((user): UserView => {
    const properties = storedProperties(user.properties);
    return {
      id: user.externalId,
      name: user.user.name,
      email: user.email,
      avatar: user.user.image,
      properties,
      groups: rules.filter((rule) => inGroup(rule.conditions, properties)).map((rule) => rule.key),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  });
}

export const listUsers = defineOperation({
  name: "users.list",
  summary:
    "List the project's users (the people your app signs in or sends with users.sync) by name, each with their `id` in your app, email, properties, the reader groups they're in now and their `activity` (posts, votes, conversations, when last seen); `q` finds them by name, email or id (whoever has that id first), `group` (a key) keeps those in that group, and `sort` puts the most posts, votes or conversations, or the latest seen, first",
  method: "GET",
  path: "/users",
  scope: "read",
  access: "team",
  input: z.object({
    // As long as an id can be, so Users can find anyone by theirs.
    q: z.string().trim().max(255).optional(),
    group: readerGroup.optional(),
    sort: z.enum(USER_SORTS).default("name"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  example: { q: "acme.com", group: "enterprise", limit: 20 },
  run: async ({ projectId }, input) => {
    const filters = [Prisma.sql`s."projectId" = ${projectId}`];
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(Prisma.sql`(s."externalId" = ${input.q} OR s.email ILIKE ${like} OR u.name ILIKE ${like})`);
    }
    if (input.group !== undefined) {
      const group = await prisma.readerGroup.findUnique({ where: { projectId_key: { projectId, key: input.group } }, select: { conditions: true } });
      if (!group) {
        throw new OperationError(404, "not_found", `There's no group “${input.group}”`);
      }
      filters.push(inGroupSql(storedConditions(group.conditions), Prisma.sql`s`));
    }
    // ponytail: offset cursors, like posts.list; switch to keyset pagination if projects get very large.
    const sorted = input.sort === "name" ? Prisma.empty : Prisma.sql`${activitySql[input.sort]} DESC NULLS LAST, `;
    const page = await prisma.$queryRaw<({ id: string } & Omit<UserActivity, "lastSeenAt"> & { lastSeen: Date | null })[]>`
      SELECT s.id, ${activitySql.posts} AS posts, ${activitySql.votes} AS votes, ${activitySql.conversations} AS conversations, ${activitySql.lastSeen} AS "lastSeen"
      FROM sso_identity s JOIN "user" u ON u.id = s."userId" ${accountsOf}
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY ${input.q ? Prisma.sql`(s."externalId" = ${input.q}) DESC, ` : Prisma.empty}${sorted}u.name, s."externalId" OFFSET ${input.cursor} LIMIT ${input.limit + 1}`;
    const rows = page.slice(0, input.limit);
    const users = await prisma.ssoIdentity.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: { id: true, ...userSelect } });
    const byId = new Map(users.map((user) => [user.id, user]));
    const views = await viewsOf(projectId, rows.map((row) => byId.get(row.id)!));
    return {
      users: views.map((view, i) => {
        const { posts, votes, conversations, lastSeen } = rows[i]!;
        return { ...view, activity: { posts, votes, conversations, lastSeenAt: lastSeen } satisfies UserActivity };
      }),
      nextCursor: page.length > input.limit ? String(input.cursor + input.limit) : null,
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
