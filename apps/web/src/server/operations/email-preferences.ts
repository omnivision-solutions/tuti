import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { changelogReach, provenAddress, reached } from "@tuti/jobs";
import { z } from "zod";

import { findSubscription } from "@/server/changelog-subscription";

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

/**
 * The changelog's subscription at the address the project's emails go to (audienceReach's: the one its SSO gives, or
 * their own), and where it stands subscribed (changelogReach as if confirmed: "private" sends none, "opted-out" none to them).
 */
export async function changelogAt(projectId: string, userId: string) {
  const person = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, emailVerified: true, ssoIdentity: { select: { projectId: true, email: true } } },
  });
  const sso = person.ssoIdentity?.projectId === projectId ? person.ssoIdentity : null;
  // Lowercase, as the changelog's subscribers are; none from a sign-on that gave no address (or a placeholder).
  const address = (sso ? sso.email : person.email)?.toLowerCase();
  const email = address && !address.endsWith(".invalid") ? address : null;
  const [subscriber, reach] = email
    ? await Promise.all([
        prisma.changelogSubscriber.findUnique({ where: { projectId_email: { projectId, email } }, select: { token: true, confirmedAt: true } }),
        changelogReach(projectId, { email, confirmed: true }),
      ])
    : [null, null];
  return { email, subscriber, reach, proven: provenAddress(person, projectId) };
}

export const updateEmailPreferences = defineOperation({
  name: "emailPreferences.update",
  summary:
    "Choose which of the project's emails about posts someone gets, as the key's creator or on behalf of someone from your app: about posts they wrote (`ownPosts`) or posts they voted on, commented on or follow (`followedPosts`), each when it ships, and the team's replies emailed to its voters (writing a post votes for it); or no emails about posts at all, nor the changelog's to their address (`unsubscribed`, as the unsubscribe link in every such email; replies to their messages and sign-in emails still arrive). The changelog entries emailed to subscribers, at the address the project's emails go to (`changelog`: on confirms it at once; off is the unsubscribe link in every changelog email; a private portal emails none). What's left out stays as it was. On someone's behalf, only turning emails off. `unsubscribed: true` and `changelog` need an address they've proven (verified, or from your single sign-on); `changelog: true` is refused while emails to that address are turned off (`unsubscribed`, or another account's at the same address)",
  method: "PATCH",
  path: "/email-preferences",
  scope: "write",
  access: "anyone",
  input: z.object({ ownPosts: z.boolean().optional(), followedPosts: z.boolean().optional(), unsubscribed: z.boolean().optional(), changelog: z.boolean().optional(), author }),
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
    // The opt-out wins (changelogReach), theirs or another account's at the address: on, it would send nothing.
    if (input.changelog && changelog?.reach === "opted-out") {
      throw new OperationError(409, "opted_out", "Emails to your address are turned off, so the changelog can't be sent to it.");
    }
    const posts = { ownPosts: input.ownPosts, followedPosts: input.followedPosts };
    if (posts.ownPosts !== undefined || posts.followedPosts !== undefined) {
      await prisma.emailPreference.upsert({ where: { userId_projectId: key }, create: { ...key, ...posts }, update: posts });
    }
    if (input.unsubscribed) {
      await prisma.emailOptOut.createMany({ data: key, skipDuplicates: true });
    } else if (input.unsubscribed === false) {
      await prisma.emailOptOut.deleteMany({ where: key });
    }
    if (input.changelog && changelog?.email) {
      // Signed in with the address proven: confirmed at once, no link to email. Already confirmed, it stays as it was.
      const at = { projectId: context.projectId, email: changelog.email };
      await prisma.changelogSubscriber.createMany({ data: at, skipDuplicates: true });
      await prisma.changelogSubscriber.updateMany({ where: { ...at, confirmedAt: null }, data: { confirmedAt: new Date() } });
    } else if (input.changelog === false && changelog?.subscriber) {
      // The unsubscribe link's own way.
      const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: context.projectId }, select: { slug: true } });
      await (await findSubscription(slug, changelog.subscriber.token))?.unsubscribe();
    }
    return emailPreferences(context.projectId, userId);
  },
});
