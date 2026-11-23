import { Prisma, prisma } from "@tuti/db";
import { historySince, visibleConversationsSql } from "@tuti/jobs";
import { z } from "zod";

import { inGroup, storedRule } from "@/lib/group-conditions";
import { readerGroup } from "@/lib/reader-groups";
import { MAX_PROPERTIES, type Properties, propertyChangesInput, storedProperties } from "@tuti/shared/user-properties";

import { inGroupSql } from "../group-conditions-sql";
import { syncUsers } from "../project-users";
import { defineOperation, OperationError } from "./define";

/**
 * The project's users (server/project-users.ts): the people its app tells Tuti about, with the
 * properties reader groups' conditions match. users.sync is how a team's app (or its AI agent) sends them.
 */

export const MAX_USERS_PER_SYNC = 1000;

const userId = z.string().min(1).max(255);

const when = (description: string) => z.string().describe(description).meta({ examples: ["2026-11-02T09:30:00.000Z"] });

/** A user as the API returns them (UserView, as JSON). */
const userFields = {
  id: z.string().describe("Their id in your app: the `sub` of your SSO tokens").meta({ examples: ["user-42"] }),
  name: z.string().describe("Their name").meta({ examples: ["Sam from Acme"] }),
  email: z.string().nullable().describe("Their email address, or null when your app hasn't given one").meta({ examples: ["e2e-sam@example.com"] }),
  avatar: z.string().nullable().describe("Their picture's URL, or null").meta({ examples: ["https://example.com/avatars/sam.png"] }),
  properties: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
    .describe("What your app tells Tuti about them (users.sync's and SSO tokens' `properties`), by name: text, numbers, booleans or lists of text")
    .meta({ examples: [{ plan: "enterprise", seats: 40, features: ["sso"] }] }),
  groups: z
    .array(z.string().meta({ examples: ["enterprise"] }))
    .describe("The keys of the reader groups they're in now: those whose conditions their properties match"),
  createdAt: when("When Tuti first heard of them"),
  updatedAt: when("When they last changed"),
};

const userOutput = z.object(userFields).meta({ id: "User", description: "One of the people your app signs in to Tuti or sends with users.sync" });

const listInput = {
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("How many a page has, up to 100"),
  cursor: z.coerce.number().int().min(0).default(0).describe("Where the page starts: the previous page's `nextCursor`"),
};
const nextCursor = z.string().nullable().describe("The next page's `cursor`, or null on the last page").meta({ examples: ["50"] });

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

/** What someone did on the project's portal and widget: posts (not merged), votes (on others' posts), conversations (not spam), and when they were last seen there. */
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

/** A user's accounts (their identity's user, and those with its address verified, not the team's), as accountsOf has them. */
export async function userAccounts(projectId: string, identity: { userId: string; email: string | null }): Promise<string[]> {
  const others = identity.email
    ? await prisma.user.findMany({
        where: {
          id: { not: identity.userId },
          emailVerified: true,
          email: { equals: identity.email, mode: "insensitive" },
          teamMemberships: { none: { projectId } },
        },
        select: { id: true },
      })
    : [];
  return [identity.userId, ...others.map((user) => user.id)];
}

/** A conversation (`c`) is theirs: with one of their accounts, or started by email from their address, verified. */
const theirConversation = Prisma.sql`(c."userId" = ANY(who.ids) OR (c."userId" IS NULL AND c."emailVerified" AND c.email = s.email))`;

/**
 * A user's activity, as SQL over their identity `s` and accounts `who` (accountsOf). Last seen is the latest of their
 * time in the widget, their posts, votes and comments, and their messages in conversations: what Tuti sees of them.
 * ponytail: worked out per user, for every user an activity sort matches; keep a summary per user if projects outgrow it.
 */
const activitySql = (shown: Prisma.Sql) => ({
  posts: Prisma.sql`(SELECT count(*) FROM post p WHERE p."projectId" = s."projectId" AND p."authorId" = ANY(who.ids) AND p."duplicateOfId" IS NULL)::int`,
  // On others' posts: everyone votes for their own (as a user's page lists them).
  votes: Prisma.sql`(SELECT count(*) FROM vote v JOIN post p ON p.id = v."postId"
    WHERE v."projectId" = s."projectId" AND v."userId" = ANY(who.ids) AND p."authorId" <> ALL(who.ids) AND p."duplicateOfId" IS NULL)::int`,
  conversations: Prisma.sql`(SELECT count(*) FROM conversation c WHERE c."projectId" = s."projectId" AND ${theirConversation} AND NOT c.spam AND ${shown})::int`,
  lastSeen: Prisma.sql`GREATEST(
    (SELECT max(w."lastSeenAt") FROM widget_presence w WHERE w."projectId" = s."projectId" AND w.who = ANY(who.ids)),
    (SELECT max(p."createdAt") FROM post p WHERE p."projectId" = s."projectId" AND p."authorId" = ANY(who.ids)),
    (SELECT max(v."createdAt") FROM vote v WHERE v."projectId" = s."projectId" AND v."userId" = ANY(who.ids)),
    (SELECT max(m."createdAt") FROM comment m WHERE m."projectId" = s."projectId" AND m."authorId" = ANY(who.ids)),
    (SELECT max(cm."createdAt") FROM conversation_message cm JOIN conversation c ON c.id = cm."conversationId"
      -- Their own messages: not someone else's on the email (in Cc), who has an address of their own.
      WHERE c."projectId" = s."projectId" AND ${theirConversation} AND cm.author = 'USER' AND cm."fromAddress" IS NULL))`,
});

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
  const groups = await prisma.readerGroup.findMany({ where: { projectId }, select: { key: true, conditions: true, match: true }, orderBy: { key: "asc" } });
  const rules = groups.map((group) => ({ key: group.key, rule: storedRule(group) }));
  return users.map((user): UserView => {
    const properties = storedProperties(user.properties);
    return {
      id: user.externalId,
      name: user.user.name,
      email: user.email,
      avatar: user.user.image,
      properties,
      groups: rules.filter((rule) => inGroup(rule.rule, properties)).map((rule) => rule.key),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  });
}

/** How many of the project's users (`s`, with their account `u`) `filters` keep. */
async function countUsers(filters: Prisma.Sql[]) {
  const [row] = await prisma.$queryRaw<[{ total: number }]>`
    SELECT count(*)::int AS total FROM sso_identity s JOIN "user" u ON u.id = s."userId" WHERE ${Prisma.join(filters, " AND ")}`;
  return row.total;
}

export const listUsers = defineOperation({
  name: "users.list",
  title: "List users",
  summary: "List the project's users (the people your app signs in or sends with users.sync), by name unless `sort` says otherwise, each with the reader groups they're in now and their activity.",
  method: "GET",
  path: "/users",
  scope: "read",
  access: "team",
  errors: [404],
  input: z.object({
    // As long as an id can be, so Users can find anyone by theirs.
    q: z.string().trim().max(255).optional().describe("Finds users by name, email or their id in your app; whoever has that id exactly comes first"),
    group: readerGroup.optional().describe("Keeps the users in this reader group, by its key"),
    company: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Keeps the users at this company: their `company` property is this text, as it is (companies.list's names)"),
    sort: z
      .enum(USER_SORTS)
      .default("name")
      .describe("`name` (A to Z), or puts the most `posts`, `votes` or `conversations` first, or the latest seen (`lastSeen`)"),
    ...listInput,
  }),
  output: z
    .object({
      users: z
        .array(
          z
            .object({
              ...userFields,
              activity: z
                .object({
                  posts: z.number().int().describe("Posts they wrote, not merged into others").meta({ examples: [3] }),
                  votes: z.number().int().describe("Their votes on others' posts").meta({ examples: [12] }),
                  conversations: z
                    .number()
                    .int()
                    .describe("Their conversations with the team, not spam nor past the plan's history")
                    .meta({ examples: [2] }),
                  lastSeenAt: z
                    .string()
                    .nullable()
                    .describe("When Tuti last saw them: in the widget, or writing a post, vote, comment or message; null if never")
                    .meta({ examples: ["2026-11-18T16:05:00.000Z"] }),
                })
                .describe("What they did on the portal and widget"),
            })
            .meta({ description: "A user, with their activity" }),
        )
        .describe("A page of users"),
      nextCursor,
      total: z.number().int().describe("Counts the users that match, all of them, on every page").meta({ examples: [128] }),
    })
    .describe("A page of the project's users"),
  example: { q: "acme.com", group: "enterprise", limit: 20 },
  run: async ({ projectId }, input) => {
    // Their conversations as the inbox shows them: not those past the plan's history.
    const activity = activitySql(visibleConversationsSql(await historySince(projectId)));
    const filters = [Prisma.sql`s."projectId" = ${projectId}`];
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(Prisma.sql`(s."externalId" = ${input.q} OR s.email ILIKE ${like} OR u.name ILIKE ${like})`);
    }
    if (input.company) {
      filters.push(Prisma.sql`jsonb_typeof(s.attributes -> 'company') = 'string' AND s.attributes ->> 'company' = ${input.company}`);
    }
    if (input.group !== undefined) {
      const group = await prisma.readerGroup.findUnique({ where: { projectId_key: { projectId, key: input.group } }, select: { conditions: true, match: true } });
      if (!group) {
        throw new OperationError(404, "not_found", `There's no group “${input.group}”`);
      }
      filters.push(inGroupSql(storedRule(group), Prisma.sql`s`));
    }
    // ponytail: offset cursors, like posts.list; switch to keyset pagination if projects get very large.
    // By name, the page is picked first and its activity worked out after; an activity sort needs everyone's.
    // Every match is sorted anyway, so counting them all here (`total`) adds little: holding them for the count took about
    // a tenth more on 100k+ users, where a count of its own took over half as long again (and could disagree with the page).
    const page = await prisma.$queryRaw<{ id: string; total: number }[]>`
      SELECT s.id, count(*) OVER ()::int AS total FROM sso_identity s JOIN "user" u ON u.id = s."userId" ${input.sort === "name" ? Prisma.empty : accountsOf}
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY ${input.q ? Prisma.sql`(s."externalId" = ${input.q}) DESC, ` : Prisma.empty}${
        input.sort === "name" ? Prisma.empty : Prisma.sql`${activity[input.sort]} DESC NULLS LAST, `
      }u.name, s."externalId" OFFSET ${input.cursor} LIMIT ${input.limit + 1}`;
    const ids = page.slice(0, input.limit).map((row) => row.id);
    const [users, counts] = await Promise.all([
      prisma.ssoIdentity.findMany({ where: { id: { in: ids } }, select: { id: true, ...userSelect } }),
      ids.length === 0
        ? []
        : prisma.$queryRaw<({ id: string } & Omit<UserActivity, "lastSeenAt"> & { lastSeen: Date | null })[]>`
            SELECT s.id, ${activity.posts} AS posts, ${activity.votes} AS votes, ${activity.conversations} AS conversations, ${activity.lastSeen} AS "lastSeen"
            FROM sso_identity s ${accountsOf} WHERE s.id IN (${Prisma.join(ids)})`,
    ]);
    const byId = new Map(users.map((user) => [user.id, user]));
    const activityOf = new Map(counts.map(({ id, lastSeen, ...counts }) => [id, { ...counts, lastSeenAt: lastSeen } satisfies UserActivity]));
    const views = await viewsOf(projectId, ids.map((id) => byId.get(id)!));
    return {
      users: views.map((view, i) => ({ ...view, activity: activityOf.get(ids[i]!)! })),
      nextCursor: page.length > input.limit ? String(input.cursor + input.limit) : null,
      // Past the last page there's no row to count on: counted on its own.
      total: page[0]?.total ?? (input.cursor === 0 ? 0 : await countUsers(filters)),
    };
  },
});

export const getUser = defineOperation({
  name: "users.get",
  title: "Get a user",
  summary: "Get one of the project's users by their id in your app, with the reader groups they're in now.",
  method: "GET",
  path: "/users/{user}",
  scope: "read",
  access: "team",
  input: z.object({ user: userId.describe("Their id in your app") }),
  output: userOutput.describe("The user"),
  run: async ({ projectId }, input) => {
    const user = await prisma.ssoIdentity.findUnique({ where: { projectId_externalId: { projectId, externalId: input.user } }, select: userSelect });
    if (!user) {
      throw new OperationError(404, "not_found", `There's no user “${input.user}”`);
    }
    return (await viewsOf(projectId, [user]))[0]!;
  },
});

const userInput = z.object({
  id: userId.describe("Their id in your app: the `sub` of your SSO tokens"),
  name: z.string().trim().min(1).max(100).optional().describe("Their name"),
  email: z.email().max(320).nullable().optional().describe("Their email address; null removes it"),
  avatar: z.url({ protocol: /^https?$/ }).max(2048).nullable().optional().describe("Their picture's URL (http or https); null removes it"),
  properties: propertyChangesInput
    .optional()
    .describe(
      `Sets the ones it names, keeping the rest: strings (up to 200 characters), numbers, booleans or lists of strings, or null, which removes one. Reader groups' conditions match them; up to ${MAX_PROPERTIES} per user`,
    ),
});

export const syncUsersOperation = defineOperation({
  name: "users.sync",
  title: "Add or update users",
  summary: `Add or change the project's users, up to ${MAX_USERS_PER_SYNC} at once, by their \`id\` in your app. Only what's given changes, and it's all or nothing. Someone signed in to your portal with a verified address is in the reader groups of the users with that email.`,
  method: "POST",
  path: "/users",
  scope: "write",
  access: "admin",
  input: z.object({
    users: z
      .array(userInput)
      .min(1, "Send at least one user")
      .max(MAX_USERS_PER_SYNC, `Up to ${MAX_USERS_PER_SYNC} users at once`)
      .refine((users) => new Set(users.map((user) => user.id)).size === users.length, "Each user once")
      .describe(`The users to add or change, each once, up to ${MAX_USERS_PER_SYNC}`),
  }),
  output: z
    .object({
      created: z.number().int().describe("How many users were new").meta({ examples: [1] }),
      updated: z.number().int().describe("How many were there already and updated").meta({ examples: [0] }),
    })
    .describe("How many users were added and how many changed"),
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

export const deleteUser = defineOperation({
  name: "users.delete",
  title: "Delete a user",
  summary:
    "Delete one of the project's users by their id in your app, when they delete their account there or ask to be forgotten: their details, votes, likes, follows, reactions, sessions and changelog subscription go; their posts, comments and conversations stay as by \"Deleted user\", without their address.",
  method: "DELETE",
  path: "/users/{user}",
  scope: "write",
  access: "admin",
  input: z.object({ user: userId.describe("Their id in your app; signed in or synced again later, the same id is a new, empty user") }),
  output: z.object({ deleted: z.string().describe("The deleted user's id in your app").meta({ examples: ["user-42"] }) }).describe("The user is gone"),
  run: async ({ projectId }, input) => {
    await prisma.$transaction(
      async (tx) => {
        // Locked, as syncUsers locks it: a sign-in or sync at once waits, then makes them anew.
        const [identity] = await tx.$queryRaw<{ id: string; userId: string; email: string | null }[]>`
          SELECT id, "userId", email FROM sso_identity WHERE "projectId" = ${projectId} AND "externalId" = ${input.user} FOR UPDATE`;
        if (!identity) {
          throw new OperationError(404, "not_found", `There's no user “${input.user}”`);
        }
        const { userId, email } = identity;
        // The posts they voted on, locked first as votes.set and merges lock them (a merge moving their votes finishes,
        // and the post it moved them to is found on the next pass), then counted again without their votes.
        const voted: string[] = [];
        for (;;) {
          const found = (await tx.vote.findMany({ where: { userId, postId: { notIn: voted } }, orderBy: { postId: "asc" }, select: { postId: true } })).map(
            (vote) => vote.postId,
          );
          if (found.length === 0) {
            break;
          }
          await tx.$queryRaw`SELECT id FROM post WHERE id = ANY(${found}::text[]) ORDER BY id FOR NO KEY UPDATE`;
          voted.push(...found);
        }
        // Every post the delete touched is counted again, with one a vote landed on since (votes.set never waits on this).
        const removed = await tx.$queryRaw<{ postId: string }[]>`DELETE FROM vote WHERE "userId" = ${userId} RETURNING "postId"`;
        const counted = [...new Set([...voted, ...removed.map((vote) => vote.postId)])];
        if (counted.length > 0) {
          await tx.$executeRaw`UPDATE post SET "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = post.id) WHERE id = ANY(${counted}::text[])`;
        }
        // Their conversations, and those started by email from their address, verified (as their page counts them):
        // kept for the team, as the deleted user's, without the address.
        const conversations = (
          await tx.conversation.findMany({
            where: { projectId, OR: [{ userId }, ...(email ? [{ userId: null, emailVerified: true, email }] : [])] },
            select: { id: true },
          })
        ).map((conversation) => conversation.id);
        await tx.conversation.updateMany({ where: { id: { in: conversations } }, data: { userId, email: null, name: null, emailVerified: false } });
        if (email) {
          await tx.conversationMessage.updateMany({
            where: { conversationId: { in: conversations }, fromAddress: { equals: email, mode: "insensitive" } },
            data: { fromAddress: null },
          });
          await tx.inboundEmail.updateMany({ where: { conversationId: { in: conversations }, sender: email }, data: { sender: "" } });
          await tx.changelogSubscriber.deleteMany({ where: { projectId, email } });
        }
        await tx.postSubscription.deleteMany({ where: { userId } });
        await tx.changelogReaction.deleteMany({ where: { userId } });
        await tx.commentLike.deleteMany({ where: { userId } });
        await tx.changelogSeen.deleteMany({ where: { userId } });
        await tx.emailPreference.deleteMany({ where: { userId } });
        await tx.emailOptOut.deleteMany({ where: { userId } });
        await tx.widgetPresence.deleteMany({ where: { projectId, who: userId } });
        await tx.portalHandoff.deleteMany({ where: { userId } });
        // Signed out everywhere: the portal's sessions end, and the widget's tokens stop working (canActIn).
        await tx.session.deleteMany({ where: { userId } });
        await tx.account.deleteMany({ where: { userId } });
        await tx.ssoIdentity.delete({ where: { id: identity.id } });
        // Its placeholder address freed, so the same id is a new user later.
        await tx.user.update({
          where: { id: userId },
          data: { name: "Deleted user", image: null, imageId: null, email: `deleted-${userId}@users.tuti.invalid`, emailVerified: false, deletedAt: new Date() },
        });
      },
      { timeout: 30_000 },
    );
    return { deleted: input.user };
  },
});

export const COMPANY_SORTS = ["users", "votes", "total"] as const;

export const listCompanies = defineOperation({
  name: "companies.list",
  title: "List companies",
  summary: "List the companies your users are at, by their `company` property, the most users first unless `sort` says otherwise. users.list's `company` lists a company's users.",
  method: "GET",
  path: "/companies",
  scope: "read",
  access: "team",
  input: z.object({
    sort: z.enum(COMPANY_SORTS).default("users").describe("The most `users` first, the most `votes`, or the biggest `total`"),
    ...listInput,
  }),
  output: z
    .object({
      property: z
        .string()
        .nullable()
        .describe("The number property `total` adds up: Who's asking, as picked in project.update (`askingProperty`); null if none is")
        .meta({ examples: ["mrr"] }),
      companies: z
        .array(
          z
            .object({
              name: z.string().describe("The company, as your users' `company` property has it").meta({ examples: ["Acme"] }),
              users: z.number().int().describe("How many of your users are at it").meta({ examples: [12] }),
              votes: z.number().int().describe("Its users' votes on others' posts, each counted once").meta({ examples: [30] }),
              total: z.number().nullable().describe("The sum of `property` over its users who have it as a number; null when none is picked or none of them has one").meta({ examples: [4800] }),
            })
            .meta({ description: "A company your users are at" }),
        )
        .describe("A page of companies"),
      nextCursor,
    })
    .describe("A page of companies"),
  example: { sort: "total", limit: 20 },
  run: async ({ projectId }, input) => {
    const { askingProperty } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { askingProperty: true } });
    const total = askingProperty
      ? Prisma.sql`sum(CASE WHEN jsonb_typeof(attributes -> ${askingProperty}::text) = 'number' THEN (attributes ->> ${askingProperty}::text)::numeric END)`
      : Prisma.sql`NULL::numeric`;
    const person = Prisma.sql`person AS (
        SELECT s.attributes ->> 'company' AS name, s.attributes, who.ids FROM sso_identity s ${accountsOf}
        WHERE s."projectId" = ${projectId} AND jsonb_typeof(s.attributes -> 'company') = 'string' AND s.attributes ->> 'company' <> ''
      ),
      company AS (SELECT name, count(*)::int AS users, ${total} AS total FROM person GROUP BY name)`;
    // A company's votes: each once, though two of its users share an account (the same address, verified), on posts none
    // of their accounts wrote, as a user's are counted; of the companies in `scope`.
    const votes = (scope: Prisma.Sql) => Prisma.sql`votes AS (
        SELECT q.name, count(DISTINCT (v."postId", v."userId"))::int AS votes
        FROM person q JOIN ${scope} USING (name) CROSS JOIN unnest(q.ids) AS a(id)
          JOIN vote v ON v."userId" = a.id JOIN post p ON p.id = v."postId"
        WHERE v."projectId" = ${projectId} AND p."duplicateOfId" IS NULL AND p."authorId" <> ALL(q.ids)
        GROUP BY q.name
      )`;
    const page = Prisma.sql`OFFSET ${input.cursor} LIMIT ${input.limit + 1}`;
    // By users or total, the page of companies first and then its votes; by votes, every company's, to pick the page.
    // ponytail: every user's accounts worked out to group them, as Users' vote sort does; a summary per user if projects
    // outgrow it. The total as text, as voterTotals has it: numbers JavaScript can hold may add up past what float8 can
    // (then it's Infinity, not an error).
    const rows =
      input.sort === "votes"
        ? await prisma.$queryRaw<{ name: string; users: number; votes: number; total: string | null }[]>`
            WITH ${person}, ${votes(Prisma.sql`company`)}
            SELECT company.name, company.users, company.total::text AS total, coalesce(votes.votes, 0) AS votes
            FROM company LEFT JOIN votes USING (name) ORDER BY votes DESC, company.users DESC, company.name ${page}`
        : await prisma.$queryRaw<{ name: string; users: number; votes: number; total: string | null }[]>`
            WITH ${person},
            page AS (
              SELECT * FROM company
              ORDER BY ${input.sort === "total" ? Prisma.sql`total DESC NULLS LAST, ` : Prisma.empty}users DESC, name ${page}
            ),
            ${votes(Prisma.sql`page`)}
            SELECT page.name, page.users, page.total::text AS total, coalesce(votes.votes, 0) AS votes
            FROM page LEFT JOIN votes USING (name)
            ORDER BY ${input.sort === "total" ? Prisma.sql`page.total DESC NULLS LAST, ` : Prisma.empty}page.users DESC, page.name`;
    return {
      property: askingProperty,
      companies: rows.slice(0, input.limit).map((row) => ({ ...row, total: row.total === null ? null : Number(row.total) })),
      nextCursor: rows.length > input.limit ? String(input.cursor + input.limit) : null,
    };
  },
});
