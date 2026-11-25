import { prisma } from "@tuti/db";
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

/** Who a call names: addresses (lowercase, each once) and the users each came from, and users with no address. */
async function named(projectId: string, input: { emails?: string[]; users?: string[] }) {
  const users = input.users ?? [];
  const identities = users.length
    ? await prisma.ssoIdentity.findMany({ where: { projectId, externalId: { in: users } }, select: { externalId: true, email: true, userId: true } })
    : [];
  const people = new Map<string, { user: string | null; by?: string }>();
  for (const email of input.emails ?? []) {
    people.set(email.toLowerCase(), { user: null });
  }
  for (const identity of identities) {
    if (identity.email && !people.has(identity.email)) {
      people.set(identity.email, { user: identity.externalId, by: identity.userId });
    }
  }
  const withEmail = new Set(identities.filter((identity) => identity.email).map((identity) => identity.externalId));
  return { people, noEmail: [...new Set(users)].filter((user) => !withEmail.has(user)) };
}

/** Adds the people a call names (addSubscribers), saying which were skipped and why. */
export async function subscribe(projectId: string, input: { emails?: string[]; users?: string[] }) {
  const { people, noEmail } = await named(projectId, input);
  const { subscribed, unsubscribed, optedOut } = await addSubscribers(projectId, [...people.keys()]);
  const skipped: Skipped[] = [
    ...unsubscribed.map((email) => ({ email, user: people.get(email)!.user, reason: "unsubscribed" as const })),
    ...optedOut.map((email) => ({ email, user: people.get(email)!.user, reason: "opted_out" as const })),
    ...noEmail.map((user) => ({ email: null, user, reason: "no_email" as const })),
  ];
  return { subscribed, skipped };
}

/** Removes the people a call names (removeSubscribers): the addresses that were subscribed. */
export async function unsubscribe(projectId: string, input: { emails?: string[]; users?: string[] }) {
  const { people } = await named(projectId, input);
  return removeSubscribers(
    projectId,
    [...people].map(([email, { by }]) => ({ email, by })),
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
