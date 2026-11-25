import { Prisma, prisma } from "@tuti/db";
import { optedOutSql } from "@tuti/jobs";
import { z } from "zod";

import { addSubscribers, removeSubscribers } from "@/server/changelog-subscription";

import { defineOperation } from "./define";

/**
 * The team's own changes to the changelog's subscribers (changelog-subscription.ts): by address, or by their users'
 * ids in its app (the address users.sync or SSO gave them). users.sync's `subscribedToChangelog` does the same.
 */

export const MAX_SUBSCRIBERS_AT_ONCE = 1000;

const SKIP_REASONS = ["unsubscribed", "opted_out", "no_email"] as const;
type Skipped = { email: string | null; user: string | null; reason: (typeof SKIP_REASONS)[number] };

/** Who a call names: addresses (lowercase, each once) with whoever named them (null: the address itself), and users with no address. */
async function named(projectId: string, input: { emails?: string[]; users?: string[] }) {
  const users = input.users ?? [];
  const identities = users.length
    ? await prisma.ssoIdentity.findMany({ where: { projectId, externalId: { in: users } }, select: { externalId: true, email: true, userId: true }, orderBy: { externalId: "asc" } })
    : [];
  const people = new Map<string, { user: string | null; by?: string }[]>();
  const add = (email: string, who: { user: string | null; by?: string }) => people.set(email, [...(people.get(email) ?? []), who]);
  for (const email of new Set((input.emails ?? []).map((email) => email.toLowerCase()))) {
    add(email, { user: null });
  }
  for (const identity of identities) {
    if (identity.email) {
      add(identity.email, { user: identity.externalId, by: identity.userId });
    }
  }
  const withEmail = new Set(identities.filter((identity) => identity.email).map((identity) => identity.externalId));
  return { people, noEmail: [...new Set(users)].filter((user) => !withEmail.has(user)) };
}

/** Adds the people a call names (addSubscribers), saying which were skipped and why: each who named a skipped address. */
export async function subscribe(projectId: string, input: { emails?: string[]; users?: string[] }) {
  const { people, noEmail } = await named(projectId, input);
  const { subscribed, unsubscribed, optedOut } = await addSubscribers(projectId, [...people.keys()]);
  const skips = (emails: string[], reason: Skipped["reason"]) => emails.flatMap((email) => people.get(email)!.map(({ user }) => ({ email, user, reason })));
  const skipped: Skipped[] = [
    ...skips(unsubscribed, "unsubscribed"),
    ...skips(optedOut, "opted_out"),
    ...noEmail.map((user) => ({ email: null, user, reason: "no_email" as const })),
  ];
  return { subscribed, skipped };
}

/**
 * Removes the people a call names (removeSubscribers): the addresses that were subscribed. The webhook names the user
 * that named an address where one did; none where several did.
 */
export async function unsubscribe(projectId: string, input: { emails?: string[]; users?: string[] }) {
  const { people } = await named(projectId, input);
  return removeSubscribers(
    projectId,
    [...people].map(([email, who]) => {
      const users = who.filter((one) => one.by);
      return { email, by: users.length === 1 ? users[0]!.by : undefined };
    }),
  );
}

const peopleInput = z
  .object({
    emails: z
      .array(z.email().max(320))
      .max(MAX_SUBSCRIBERS_AT_ONCE)
      .optional()
      .describe("Their email addresses")
      .meta({ examples: [["e2e-sam@example.com"]] }),
    users: z
      .array(z.string().min(1).max(255))
      .max(MAX_SUBSCRIBERS_AT_ONCE)
      .optional()
      .describe("Their ids in your app: the address users.sync or your single sign-on gave each"),
  })
  .refine((input) => (input.emails?.length ?? 0) + (input.users?.length ?? 0) > 0, "Send at least one address or user")
  .refine(
    (input) => (input.emails?.length ?? 0) + (input.users?.length ?? 0) <= MAX_SUBSCRIBERS_AT_ONCE,
    `Up to ${MAX_SUBSCRIBERS_AT_ONCE} addresses and users at once`,
  );

const skippedOutput = z
  .array(
    z.object({
      email: z.string().nullable().describe("The address, or null for a user with none").meta({ examples: ["e2e-sam@example.com"] }),
      user: z.string().nullable().describe("The user it came from, by their id in your app; null for an address you sent").meta({ examples: [null] }),
      reason: z
        .enum(SKIP_REASONS)
        .describe(
          "`unsubscribed`: they unsubscribed, and only a link emailed to them can sign them up again (the portal's form); `opted_out`: all of your project's emails to that address are off; `no_email`: no user with that id, or one without an address",
        )
        .meta({ examples: ["unsubscribed"] }),
    }),
  )
  .describe("Those not added, and why");

export const addChangelogSubscribers = defineOperation({
  name: "changelogSubscribers.add",
  title: "Add changelog subscribers",
  summary: `Subscribe people to the changelog's emails, up to ${MAX_SUBSCRIBERS_AT_ONCE} at once, by address or by user: confirmed at once on your word (no email asks), for entries emailed from now on. Never someone who unsubscribed or turned off your project's emails; those are returned in \`skipped\`. A private portal emails none`,
  method: "POST",
  path: "/changelog-subscribers",
  scope: "write",
  access: "admin",
  input: peopleInput,
  output: z
    .object({
      subscribed: z.array(z.string().meta({ examples: ["e2e-sam@example.com"] })).describe("The addresses subscribed now, those that were already too"),
      skipped: skippedOutput,
    })
    .meta({ id: "AddedSubscribers", description: "Who was subscribed to the changelog, and who wasn't" })
    .describe("Who is subscribed now, and who wasn't added"),
  example: { emails: ["e2e-sam@example.com"], users: ["user-42"] },
  run: ({ projectId }, input) => subscribe(projectId, input),
});

export const removeChangelogSubscribers = defineOperation({
  name: "changelogSubscribers.remove",
  title: "Remove changelog subscribers",
  summary: `Stop emailing the changelog to people, up to ${MAX_SUBSCRIBERS_AT_ONCE} at once, by address or by user. Webhooks hear \`changelog.unsubscribed\` (\`source\` api) for each it was being emailed to. You can add them back later`,
  method: "POST",
  path: "/changelog-subscribers/remove",
  scope: "write",
  access: "admin",
  input: peopleInput,
  output: z
    .object({
      removed: z.array(z.string().meta({ examples: ["e2e-sam@example.com"] })).describe("The addresses that were subscribed"),
    })
    .meta({ id: "RemovedSubscribers", description: "Who was removed from the changelog's subscribers" })
    .describe("The addresses that were subscribed"),
  example: { emails: ["e2e-sam@example.com"] },
  run: async ({ projectId }, input) => ({ removed: await unsubscribe(projectId, input) }),
});

/**
 * Where an address stands: `subscribed` (confirmed; emailed while the portal is public and the project's email isn't
 * paused), `pending` (a confirmation link is out), `unsubscribed` (its owner left: only they can come back),
 * `opted_out` (all of the project's emails off) or `removed` (by the team, or a link never sent: the team can add it).
 */
export const SUBSCRIBER_STATUSES = ["subscribed", "pending", "unsubscribed", "opted_out", "removed"] as const;

export const listChangelogSubscribers = defineOperation({
  name: "changelogSubscribers.list",
  title: "List changelog subscribers",
  summary:
    "List the addresses that asked for the changelog by email or that you added, newest first, each with where it stands and the user at that address in your app, if any",
  method: "GET",
  path: "/changelog-subscribers",
  scope: "read",
  access: "team",
  input: z.object({
    q: z.string().trim().max(320).optional().describe("Finds addresses containing this"),
    status: z.enum(SUBSCRIBER_STATUSES).optional().describe("Keeps those with this status"),
    limit: z.coerce.number().int().min(1).max(100).default(50).describe("How many a page has, up to 100"),
    cursor: z.coerce.number().int().min(0).default(0).describe("Where the page starts: the previous page's `nextCursor`"),
  }),
  output: z
    .object({
      subscribers: z
        .array(
          z.object({
            email: z.string().describe("Their address, lowercase").meta({ examples: ["e2e-sam@example.com"] }),
            user: z.string().nullable().describe("The user at this address, by their id in your app; null for none").meta({ examples: ["user-42"] }),
            status: z
              .enum(SUBSCRIBER_STATUSES)
              .describe(
                "`subscribed`: confirmed (emailed while your portal is public and your project's email isn't paused); `pending`: a confirmation link was emailed; `unsubscribed`: they left, and only they can come back; `opted_out`: all of your project's emails to them are off; `removed`: by you (you can add them back)",
              )
              .meta({ examples: ["subscribed"] }),
            subscribedAt: z.string().nullable().describe("When they were confirmed, or null").meta({ examples: ["2026-11-18T16:05:00.000Z"] }),
            createdAt: z.string().describe("When the address first asked or was added").meta({ examples: ["2026-11-18T16:00:00.000Z"] }),
          }),
        )
        .describe("A page of subscribers"),
      nextCursor: z.string().nullable().describe("The next page's `cursor`, or null on the last page").meta({ examples: ["50"] }),
      total: z.number().int().describe("Counts those that match, on every page").meta({ examples: [128] }),
    })
    .describe("A page of the changelog's subscribers"),
  example: { status: "subscribed", limit: 20 },
  run: async ({ projectId }, input) => {
    const like = input.q ? `%${input.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const matching = Prisma.sql`(
      SELECT s."email", s."confirmedAt", s."createdAt", s."id",
        CASE
          WHEN s."unsubscribedAt" IS NOT NULL THEN 'unsubscribed'
          WHEN ${optedOutSql(projectId, Prisma.raw(`s."email"`))} THEN 'opted_out'
          WHEN s."confirmedAt" IS NOT NULL THEN 'subscribed'
          WHEN s."confirmTokenHash" IS NOT NULL THEN 'pending'
          ELSE 'removed'
        END AS "status"
      FROM "changelog_subscriber" s
      WHERE s."projectId" = ${projectId} ${like ? Prisma.sql`AND s."email" LIKE ${like}` : Prisma.empty}
    ) t ${input.status ? Prisma.sql`WHERE t."status" = ${input.status}` : Prisma.empty}`;
    // ponytail: offset cursors and a count over every match, like users.list; keyset pagination if lists get very large.
    const rows = await prisma.$queryRaw<{ email: string; user: string | null; status: (typeof SUBSCRIBER_STATUSES)[number]; confirmedAt: Date | null; createdAt: Date; total: number }[]>`
      SELECT page.*,
        -- The user at each address, for the page's rows only.
        (SELECT i."externalId" FROM "sso_identity" i WHERE i."projectId" = ${projectId} AND lower(i."email") = page."email" ORDER BY i."externalId" LIMIT 1) AS "user"
      FROM (
        SELECT t.*, count(*) OVER ()::int AS total FROM ${matching}
        ORDER BY t."createdAt" DESC, t."id" OFFSET ${input.cursor} LIMIT ${input.limit + 1}
      ) page
      ORDER BY page."createdAt" DESC, page."id"`;
    // Past the last page there's no row to count on: counted on its own.
    const total = rows[0]?.total ?? (input.cursor === 0 ? 0 : (await prisma.$queryRaw<[{ total: number }]>`SELECT count(*)::int AS total FROM ${matching}`)[0].total);
    return {
      subscribers: rows.slice(0, input.limit).map((row) => ({
        email: row.email,
        user: row.user,
        status: row.status,
        subscribedAt: row.confirmedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? String(input.cursor + input.limit) : null,
      total,
    };
  },
});
