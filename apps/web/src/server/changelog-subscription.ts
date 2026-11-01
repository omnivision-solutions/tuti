import { randomBytes } from "node:crypto";

import { prisma } from "@tuti/db";
import { changelogConfirmEmail, sendEmail } from "@tuti/email";
import { changelogReach, type ChangelogReach, projectSender } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { hashSecret } from "@/lib/portal-handoff";
import { portalAddress } from "@/server/custom-domains";


/**
 * Where a subscription stands, as the sender sees it (changelogReach): the one sentence every state of this page says,
 * so it never promises what isn't sent.
 */
export function reachSentence(reach: ChangelogReach, name: string, email: string): string {
  switch (reach) {
    case "gets":
      return `New entries in ${name}'s changelog go to ${email} as they're published.`;
    case "paused":
      return `New entries in ${name}'s changelog go to ${email} once ${name}'s emails, paused for now, are resumed.`;
    case "unconfirmed":
      return `${name}'s changelog isn't emailed to ${email}.`;
    case "private":
      return `${name}'s portal is private, so its changelog isn't emailed to ${email}.`;
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
const optOutsAt = (projectId: string, email: string) => ({
  projectId,
  user: {
    OR: [
      { email: { equals: email, mode: "insensitive" as const } },
      { ssoIdentity: { projectId, email: { equals: email, mode: "insensitive" as const } } },
    ],
  },
});


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
        projectName: project.name,
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
  return {
    ...subscriber,
    // Where they stand, by the sender's own rule (changelogReach): what their page says.
    reach: await changelogReach(subscriber.projectId, { email: subscriber.email, confirmed: subscriber.confirmedAt !== null }),
    // Any confirmation link still out goes too: it can't sign them up again (asking again on the portal can).
    unsubscribe: () =>
      prisma.changelogSubscriber.updateMany({
        where: { id: subscriber.id, token },
        data: { confirmedAt: null, confirmTokenHash: null, confirmExpiresAt: null, confirmUsedAt: null },
      }),
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
     * replaced or used meanwhile does nothing. Not while the portal's private: nothing is emailed from one (changelogEmailed).
     */
    confirm: (emailsOn: boolean) =>
      prisma.$transaction(async (tx) => {
        const now = new Date();
        const { count } = await tx.changelogSubscriber.updateMany({
          where: { id, confirmTokenHash, confirmExpiresAt: { gt: now }, confirmUsedAt: null, project: { portalAccess: "PUBLIC" } },
          data: { confirmedAt: now, confirmUsedAt: now },
        });
        // Only the opt-outs from before the link was sent: one made since stays (and voids the link).
        if (count === 1 && emailsOn) {
          await tx.emailOptOut.deleteMany({ where: { ...optOutsAt(projectId, email), createdAt: { lte: issuedAt } } });
        }
        return count === 1;
      }),
  };
}
