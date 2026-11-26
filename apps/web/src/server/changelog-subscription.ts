import { randomBytes } from "node:crypto";

import { type Prisma, prisma } from "@tuti/db";
import { changelogConfirmEmail, sendEmail } from "@tuti/email";
import {
  changelogReach,
  type ChangelogReach,
  emailBrand,
  emailedOf,
  optedOutOf,
  projectEmailWaits,
  projectSender,
  provenAddress,
  queueDeliveries,
  recordEvent,
} from "@tuti/jobs";
import { log } from "@tuti/shared";

import { hashSecret } from "@/lib/portal-handoff";
import { portalAddress } from "@/server/custom-domains";
import { withLockRetries } from "@/server/lock-retries";


/**
 * Where a subscription stands, as the sender sees it (changelogReach): the one sentence every state of this page says,
 * so it never promises what isn't sent.
 */
export function reachSentence(reach: ChangelogReach, name: string, email: string): string {
  switch (reach) {
    // Only the entries the team publishes with Email subscribers: it's their choice each time.
    case "gets":
      return `The changelog entries ${name} emails to subscribers go to ${email}.`;
    case "paused":
      return `The changelog entries ${name} emails to subscribers go to ${email} once ${name}'s emails, paused for now, are resumed.`;
    case "unconfirmed":
      return `${name}'s changelog isn't emailed to ${email}.`;
    case "private":
      return `${name}'s portal is private and ${email} isn't one of its readers, so its changelog isn't emailed there.`;
    case "opted-out":
      return `You've turned off all of ${name}'s emails, so its changelog isn't emailed to ${email} either.`;
  }
}

/** How long a changelog confirmation link works (each request's own, used once). */
export const CONFIRM_LINK_HOURS = 24;

const select = {
  id: true,
  email: true,
  confirmedAt: true,
  token: true,
  projectId: true,
  project: { select: { name: true, slug: true, portalAccess: true } },
} as const;

/** The opt-outs at an address: any account's there, by its own address or the one the project's SSO gives it (as changelogReach matches them). */
export const optOutsAt = (projectId: string, email: string) => ({
  projectId,
  user: {
    OR: [
      { email: { equals: email, mode: "insensitive" as const } },
      { ssoIdentity: { projectId, email: { equals: email, mode: "insensitive" as const } } },
    ],
  },
});


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

/**
 * How the changelog stopped being emailed to an address, for the changelog.unsubscribed webhook: the email's own link
 * (its page or one click from a mail app, the project's Unsubscribe too), the portal's Account, or the team's app (the API).
 */
export type UnsubscribeSource = "email" | "account" | "api";

/**
 * The changelog.unsubscribed event (its deliveries saved with `tx`, to queue once it commits): the address, the
 * person's id in the project's app, how, and whether it was all of the project's emails or just the changelog. The id
 * is `by`'s (the account that acted) where it's known, else that of the one user the project's SSO or API has at the
 * address; null for none, or several (addresses aren't unique).
 */
async function recordUnsubscribe(
  tx: Prisma.TransactionClient,
  projectId: string,
  email: string,
  { source, allEmails, by }: { source: UnsubscribeSource; allEmails: boolean; by?: string },
) {
  const known = await tx.ssoIdentity.findMany({
    where: { projectId, ...(by ? { userId: by } : { email: { equals: email, mode: "insensitive" } }) },
    select: { externalId: true },
    take: 2,
  });
  return recordEvent(tx, projectId, "changelog.unsubscribed", {
    email,
    userId: known.length === 1 ? known[0]!.externalId : null,
    source,
    allEmails,
    unsubscribedAt: new Date(),
  });
}

/**
 * Of these addresses (lowercase), the subscribers that are confirmed, and those the changelog is emailed to now
 * (emailedOf: confirmed ones changelogReach reaches), with their rows locked till `tx` ends, in one order: every way
 * out at an address takes its row first, so they take turns, each sees what the one before did, and only the one that
 * stops it tells webhooks. Read in `tx` too: a second connection, waited for while holding the lock, would run the
 * pool dry under a burst of one-click unsubscribes.
 */
async function lockSubscribers(tx: Prisma.TransactionClient, projectId: string, emails: string[]) {
  const rows = await tx.$queryRaw<{ email: string; confirmed: boolean }[]>`
    SELECT "email", "confirmedAt" IS NOT NULL AS confirmed FROM "changelog_subscriber"
    WHERE "projectId" = ${projectId} AND "email" = ANY(${emails}::text[]) ORDER BY "email" FOR UPDATE`;
  return { confirmed: new Set(rows.filter((row) => row.confirmed).map((row) => row.email)), emailed: await emailedOf(tx, projectId, emails) };
}

/** lockSubscribers for one address: whether the changelog is emailed to it now. */
const emailedNow = async (tx: Prisma.TransactionClient, projectId: string, email: string) =>
  (await lockSubscribers(tx, projectId, [email])).emailed.has(email);

/**
 * The team adds subscribers (lowercase addresses): confirmed at once, on the team's word, from now on (entries
 * published before aren't sent). Never an address that unsubscribed (only a link emailed to it can sign it up again)
 * or where all of the project's emails are off: those are returned, not added. One already subscribed stays as it was.
 */
export async function addSubscribers(projectId: string, emails: string[]) {
  return withLockRetries(() =>
    prisma.$transaction(
    async (tx) => {
      const optedOutBefore = await optedOutOf(tx, projectId, emails);
      let rest = emails.filter((email) => !optedOutBefore.has(email));
      // Made and then locked in lockSubscribers' order, so adds, removals and unsubscribes at once queue, not deadlock;
      // an unsubscribe meanwhile is waited for and seen: it's left.
      await tx.changelogSubscriber.createMany({ data: [...rest].sort().map((email) => ({ projectId, email })), skipDuplicates: true });
      await lockSubscribers(tx, projectId, rest);
      // Read again with the rows held: an opt-out made meanwhile (which takes them too, where there's one) is seen.
      const optedOut = new Set([...optedOutBefore, ...(await optedOutOf(tx, projectId, rest))]);
      rest = rest.filter((email) => !optedOut.has(email));
      await tx.changelogSubscriber.updateMany({
        where: { projectId, email: { in: rest }, confirmedAt: null, unsubscribedAt: null },
        data: { confirmedAt: new Date() },
      });
      const left = new Set(
        (await tx.changelogSubscriber.findMany({ where: { projectId, email: { in: rest }, confirmedAt: null }, select: { email: true } })).map((row) => row.email),
      );
      return {
        subscribed: rest.filter((email) => !left.has(email)),
        unsubscribed: rest.filter((email) => left.has(email)),
        optedOut: emails.filter((email) => optedOut.has(email)),
      };
    },
    { timeout: 60_000 },
    ),
  );
}

/**
 * The team removes subscribers (`email` lowercase; `by`: the account of the person in its app, where it named them),
 * as their own unsubscribe does, without marking them unsubscribed: the team can add them back. Any confirmation link
 * still out goes too. Webhooks hear changelog.unsubscribed (`source` api) for each it stops emailing. Returns the
 * addresses that were subscribed.
 */
export async function removeSubscribers(projectId: string, people: { email: string; by?: string }[]) {
  const emails = people.map((person) => person.email);
  const { removed, deliveries } = await withLockRetries(() =>
    prisma.$transaction(
    async (tx) => {
      const { confirmed, emailed } = await lockSubscribers(tx, projectId, emails);
      await tx.changelogSubscriber.updateMany({
        where: { projectId, email: { in: emails } },
        data: { confirmedAt: null, confirmTokenHash: null, confirmExpiresAt: null, confirmUsedAt: null },
      });
      const deliveries: string[] = [];
      for (const { email, by } of people) {
        if (emailed.has(email)) {
          deliveries.push(...(await recordUnsubscribe(tx, projectId, email, { source: "api", allEmails: false, by })));
        }
      }
      return { removed: emails.filter((email) => confirmed.has(email)), deliveries };
    },
    { timeout: 60_000 },
    ),
  );
  await queueDeliveries(deliveries);
  return removed;
}

/**
 * Turns off all of the project's emails for someone (the opt-out), telling webhooks changelog.unsubscribed when that
 * stops the changelog at their address (changelogAt's): only when it was being emailed there and this is what stopped it.
 */
export async function optOut(projectId: string, userId: string, source: UnsubscribeSource) {
  const { email } = await changelogAt(projectId, userId);
  const deliveries = await prisma.$transaction(async (tx) => {
    const stops = email !== null && (await emailedNow(tx, projectId, email));
    const { count } = await tx.emailOptOut.createMany({ data: { userId, projectId }, skipDuplicates: true });
    return count === 1 && stops ? recordUnsubscribe(tx, projectId, email, { source, allEmails: true, by: userId }) : [];
  });
  await queueDeliveries(deliveries);
}

/**
 * Emails a subscriber a confirmation link of their own (32 random bytes, stored hashed like sign-in links), used once,
 * for CONFIRM_LINK_HOURS. It replaces any link sent before, so an old one (forwarded, say) confirms nothing. To an
 * address that's turned all of the project's emails off, it says so and turns them back on, rather than promising the
 * changelog. Callers count it against the emailed links' limits first (countEmailedLink).
 */
export async function emailConfirmation(
  project: { id: string; name: string; slug: string },
  subscriber: { id: string; email: string },
): Promise<{ error?: string }> {
  const confirm = randomBytes(32).toString("base64url");
  await prisma.changelogSubscriber.update({
    where: { id: subscriber.id },
    data: { confirmTokenHash: hashSecret(confirm), confirmExpiresAt: new Date(Date.now() + CONFIRM_LINK_HOURS * 3_600_000), confirmUsedAt: null },
  });
  const url = new URL(`${await portalAddress(project.slug)}/changelog/subscription`);
  url.searchParams.set("confirm", confirm);
  try {
    await sendEmail({
      to: subscriber.email,
      ...changelogConfirmEmail({
        ...(await emailBrand(project.id)),
        url: url.toString(),
        optedOut: (await changelogReach(project.id, { email: subscriber.email, confirmed: true })) === "opted-out",
      }),
      ...(await projectSender(project.id)),
    });
  } catch (error) {
    log.error("Sending a changelog confirmation failed", { error });
    return { error: "We couldn't send the email. Try again." };
  }
  return {};
}

/**
 * A changelog subscription from the token in every changelog email's unsubscribe link; the link's portal says which
 * project. Null when either is unknown. That token is long-lived (and in forwarded emails), so it only unsubscribes, or
 * asks for a confirmation link to be emailed to the address: confirming, and turning the project's emails back on,
 * take that link (findConfirmation). Not a "use server" module: the token is the permission, checked by the pages and
 * routes that take it.
 */
export async function findSubscription(projectSlug: string, token: string) {
  const subscriber = token ? await prisma.changelogSubscriber.findFirst({ where: { token, project: { slug: projectSlug } }, select }) : null;
  if (!subscriber) {
    return null;
  }
  // Where they stand, by the sender's own rule (changelogReach): what their page says.
  const reach = await changelogReach(subscriber.projectId, { email: subscriber.email, confirmed: subscriber.confirmedAt !== null });
  return {
    ...subscriber,
    reach,
    // The project's email is paused: no link can be emailed for now (opted out, they'd ask for one).
    paused: await projectEmailWaits(subscriber.projectId),
    /**
     * Any confirmation link still out goes too: it can't sign them up again (asking again on the portal can). A confirmed
     * one is marked unsubscribed (the team can't add it back), so is one the team removed, and webhooks hear changelog.unsubscribed if it was being
     * emailed (changelogReach): not again for one already ended, nor where all of the project's emails were off already.
     * `by`: the account that did it, where one did (the Account switch), named in the event.
     */
    unsubscribe: async (source: UnsubscribeSource, by?: string) => {
      const deliveries = await prisma.$transaction(async (tx) => {
        const stops = await emailedNow(tx, subscriber.projectId, subscriber.email);
        const { count } = await tx.changelogSubscriber.updateMany({
          // Confirmed or not (removed by the team since, say): the token is only ever given to the address's owner
          // (its emails, its confirmed page, their Account), so it's their own choice either way.
          where: { id: subscriber.id, token, unsubscribedAt: null },
          data: { unsubscribedAt: new Date() },
        });
        await tx.changelogSubscriber.updateMany({
          where: { id: subscriber.id, token },
          data: { confirmedAt: null, confirmTokenHash: null, confirmExpiresAt: null, confirmUsedAt: null },
        });
        return count === 1 && stops ? recordUnsubscribe(tx, subscriber.projectId, subscriber.email, { source, allEmails: false, by }) : [];
      });
      await queueDeliveries(deliveries);
    },
  };
}

/**
 * The request a confirmation link (`confirm`, its own token) was emailed for: only the latest request's (a newer one
 * replaces it, unsubscribing voids it, and so does turning the project's emails off after it was sent), within
 * CONFIRM_LINK_HOURS. Null otherwise; except a `used` one, which is still known past its hours (still doing nothing),
 * so it says where they stand rather than send someone confirmed to ask again for nothing. It confirms only while
 * `live` (unused, unexpired); once `used`, it only says so.
 * `reach` "opted-out": the address had turned all of the project's emails off when it was sent, so confirming turns them
 * back on too (the link, emailed to it then, shows it's theirs); never an opt-out made since, which voids the link.
 */
export async function findConfirmation(projectSlug: string, confirm: string) {
  const confirmTokenHash = hashSecret(confirm);
  const subscriber = confirm
    ? await prisma.changelogSubscriber.findFirst({
        where: {
          confirmTokenHash,
          OR: [{ confirmExpiresAt: { gt: new Date() } }, { confirmUsedAt: { not: null } }],
          project: { slug: projectSlug },
        },
        select: { ...select, confirmUsedAt: true, confirmExpiresAt: true },
      })
    : null;
  if (!subscriber) {
    return null;
  }
  const { id, projectId, email } = subscriber;
  // When it was sent (its expiry less its hours): an opt-out since then voids it.
  const issuedAt = new Date(subscriber.confirmExpiresAt!.getTime() - CONFIRM_LINK_HOURS * 3_600_000);
  if ((await prisma.emailOptOut.count({ where: { ...optOutsAt(projectId, email), createdAt: { gt: issuedAt } } })) > 0) {
    return null;
  }
  return {
    ...subscriber,
    live: subscriber.confirmUsedAt === null && subscriber.confirmExpiresAt! > new Date(),
    used: subscriber.confirmUsedAt !== null,
    // Where confirming leaves them, by the sender's own rule (changelogReach): what the page says before they press.
    reach: await changelogReach(projectId, { email, confirmed: true }),
    /**
     * Confirms (with `emailsOn`, the opted-out page's button, turning the project's emails back on at the address too:
     * every account's opt-out there), once: the same token, unused and unexpired, checked as it writes, so a link
     * replaced or used meanwhile does nothing. On a private portal too: what it sends to the address then is its reach (only to a reader).
     */
    confirm: (emailsOn: boolean) =>
      prisma.$transaction(async (tx) => {
        const now = new Date();
        const { count } = await tx.changelogSubscriber.updateMany({
          where: { id, confirmTokenHash, confirmExpiresAt: { gt: now }, confirmUsedAt: null },
          data: { confirmedAt: now, confirmUsedAt: now, unsubscribedAt: null },
        });
        // Only the opt-outs from before the link was sent: one made since stays (and voids the link).
        if (count === 1 && emailsOn) {
          await tx.emailOptOut.deleteMany({ where: { ...optOutsAt(projectId, email), createdAt: { lte: issuedAt } } });
        }
        return count === 1;
      }),
  };
}
