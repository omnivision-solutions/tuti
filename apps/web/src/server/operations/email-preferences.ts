import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { reached } from "@tuti/jobs";
import { z } from "zod";

import { changelogAt, findSubscription, optOut, optOutsAt } from "@/server/changelog-subscription";

import { author, authorId } from "./create";
import { defineOperation, OperationError } from "./define";

/**
 * Which of the project's emails someone gets (their portal's Account): about posts they wrote, about posts they voted on
 * or follow, the changelog at their address (changelogAt), or none of these (the opt-out).
 */
export async function emailPreferences(projectId: string, userId: string) {
  return (await accountEmails(projectId, userId)).preferences;
}

/** emailPreferences, with where the changelog stands at their address (changelogAt), read once for the Account page. */
export async function accountEmails(projectId: string, userId: string) {
  const key = { userId_projectId: { userId, projectId } };
  const [preference, optOut, changelog] = await Promise.all([
    prisma.emailPreference.findUnique({ where: key, select: { ownPosts: true, followedPosts: true } }),
    prisma.emailOptOut.findUnique({ where: key }),
    changelogAt(projectId, userId),
  ]);
  const preferences = {
    ownPosts: preference?.ownPosts ?? true,
    followedPosts: preference?.followedPosts ?? true,
    unsubscribed: optOut !== null,
    // Whether the sender emails it to them (changelogReach: an unconfirmed subscriber is never reached), so an opt-out at
    // the address, theirs or another account's there, shows it off. Only to whoever proved the address is theirs: it
    // tells nobody else who's subscribed (as the changelog's own box).
    changelog: changelog.proven && changelog.subscriber?.confirmedAt != null && changelog.reach !== null && reached(changelog.reach),
  };
  return { preferences, changelog };
}


export const updateEmailPreferences = defineOperation({
  name: "emailPreferences.update",
  title: "Set email preferences",
  summary:
    "Choose which of the project's emails someone gets, as the key's creator or on behalf of someone from your app (`author`; on someone's behalf, only turning emails off). What's left out stays as it was, and a refused update changes nothing.",
  method: "PATCH",
  path: "/email-preferences",
  scope: "write",
  access: "anyone",
  errors: [409],
  input: z.object({
    ownPosts: z.boolean().optional().describe("Emails about posts they wrote, others' comments on them too, as each moves forward and when it ships"),
    followedPosts: z
      .boolean()
      .optional()
      .describe(
        "Emails about posts they voted on, commented on or follow, as each moves forward and when it ships, and the team's replies emailed to a post's voters (writing a post votes for it)",
      ),
    unsubscribed: z
      .boolean()
      .optional()
      .describe(
        "No emails about posts at all, nor the changelog's to their address, as the unsubscribe link in every such email; replies to their messages and sign-in emails still arrive. `true` and `changelog` need an address they've proven (verified, or from your single sign-on)",
      ),
    changelog: z
      .boolean()
      .optional()
      .describe(
        "The changelog entries emailed to subscribers, at the address the project's emails go to: on confirms it at once, off is the unsubscribe link in every changelog email; a private portal emails none. `true` is refused while emails to that address are turned off (`unsubscribed`, or another account's at the same address; `unsubscribed: false` in the same update counts)",
      ),
    author: author.describe("Someone from your app to act for (API keys only): their `id` in your app; without it, the key's creator"),
  }),
  output: z
    .object({
      ownPosts: z.boolean().describe("Whether they get emails about posts they wrote").meta({ examples: [true] }),
      followedPosts: z.boolean().describe("Whether they get emails about posts they voted on, commented on or follow").meta({ examples: [false] }),
      unsubscribed: z.boolean().describe("Whether they turned off emails about posts and the changelog's").meta({ examples: [false] }),
      changelog: z.boolean().describe("Whether the changelog is emailed to their address").meta({ examples: [false] }),
    })
    .meta({ id: "EmailPreferences", description: "Which of the project's emails someone gets" })
    .describe("Their email preferences now"),
  example: { followedPosts: false, author: { id: "user-42" } },
  run: async (context, input) => {
    // For someone from the app, only ever fewer emails: what they turned off (here or by an email's link) stays off.
    if (input.author && (input.ownPosts || input.followedPosts || input.unsubscribed === false || input.changelog)) {
      throw new OperationError(403, "forbidden", "Only the person themselves can turn their emails back on");
    }
    const userId = await authorId(context, input.author);
    const key = { userId, projectId: context.projectId };
    // An opt-out counts against an address (the changelog's subscribers at it too), and so does its changelog: only from
    // someone who proved it's theirs, so nobody can sign up as another's address and silence or sign up its emails.
    // Their own switches are theirs alone.
    const changelog = input.unsubscribed || input.changelog !== undefined ? await changelogAt(context.projectId, userId) : null;
    if (changelog && !changelog.proven) {
      throw new OperationError(403, "unconfirmed", input.unsubscribed ? "Confirm your email address to stop these emails" : "Confirm your email address first");
    }
    // As the changelog's own box has it: not where no email is sent, to a private portal's readers, nor without an address.
    if (input.changelog && (!emailConfigured() || !changelog?.email || changelog.reach === "private")) {
      throw new OperationError(403, "unavailable", "Updates by email aren't available here.");
    }
    // The opt-out wins (changelogReach), theirs or another account's at the address: on, it would send nothing. Decided
    // before any write, so a refused update changes nothing: turning their own back on in it leaves only the others'.
    if (
      input.changelog &&
      changelog?.email &&
      (input.unsubscribed === false
        ? (await prisma.emailOptOut.count({ where: { ...optOutsAt(context.projectId, changelog.email), userId: { not: userId } } })) > 0
        : changelog.reach === "opted-out")
    ) {
      throw new OperationError(409, "opted_out", "Emails to your address are turned off, so the changelog can't be sent to it.");
    }
    // For the changelog.unsubscribed webhook: the person on their Account page, or the team's app (an API key).
    const source = context.actor.kind === "apiKey" ? "api" : "account";
    const posts = { ownPosts: input.ownPosts, followedPosts: input.followedPosts };
    if (posts.ownPosts !== undefined || posts.followedPosts !== undefined) {
      await prisma.emailPreference.upsert({ where: { userId_projectId: key }, create: { ...key, ...posts }, update: posts });
    }
    if (input.unsubscribed) {
      await optOut(context.projectId, userId, source);
    } else if (input.unsubscribed === false) {
      await prisma.emailOptOut.deleteMany({ where: key });
    }
    if (input.changelog && changelog?.email) {
      // Signed in with the address proven: confirmed at once, no link to email. Already confirmed, it stays as it was.
      const at = { projectId: context.projectId, email: changelog.email };
      await prisma.changelogSubscriber.createMany({ data: at, skipDuplicates: true });
      await prisma.changelogSubscriber.updateMany({ where: { ...at, confirmedAt: null }, data: { confirmedAt: new Date(), unsubscribedAt: null } });
    } else if (input.changelog === false && changelog?.subscriber) {
      // The unsubscribe link's own way.
      const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: context.projectId }, select: { slug: true } });
      await (await findSubscription(slug, changelog.subscriber.token))?.unsubscribe(source, userId);
    }
    return emailPreferences(context.projectId, userId);
  },
});
