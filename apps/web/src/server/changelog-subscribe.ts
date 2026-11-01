"use server";

import { randomBytes } from "node:crypto";

import { prisma } from "@tuti/db";
import { changelogConfirmEmail, emailConfigured, sendEmail } from "@tuti/email";
import { projectSender } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { headers } from "next/headers";
import { z } from "zod";

import { hashSecret } from "@/lib/portal-handoff";
import { portalAddress } from "@/server/custom-domains";

import { CONFIRM_LINK_HOURS } from "./changelog-subscription";
import { countEmailedLink } from "./email-link-limits";

const fields = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")) });

/**
 * "Get updates by email" on a portal's changelog: emails a link to confirm (double opt-in), so nothing else is sent
 * until the address's owner confirms. Counted with the other emailed links' limits. Says the same whether or not the
 * address is subscribed already (which gets nothing), so it tells nobody who's subscribed. Public portals only:
 * a private one's entries are for its readers, and an address can't show it's one.
 */
export async function subscribeToChangelog(projectSlug: string, form: FormData): Promise<{ error?: string; sentTo?: string }> {
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true, portalAccess: true } });
  if (!project || project.portalAccess !== "PUBLIC" || !emailConfigured()) {
    return { error: "Updates by email aren't available here." };
  }
  const parsed = fields.safeParse({ email: form.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const { email } = parsed.data;
  const limited = await countEmailedLink(project.id, email, await headers());
  if ("error" in limited) {
    return { error: limited.error };
  }
  if (!limited.id) {
    // Over the per-visitor limit: nothing is sent, but the answer is the same, so it tells them nothing.
    return { sentTo: email };
  }
  const subscriber = await prisma.changelogSubscriber.upsert({
    where: { projectId_email: { projectId: project.id, email } },
    create: { projectId: project.id, email },
    update: {},
    select: { id: true, confirmedAt: true },
  });
  if (subscriber.confirmedAt) {
    return { sentTo: email };
  }
  // A new one, or one not confirmed (asked before, or unsubscribed since): confirmed by this request's own link only,
  // used once, for CONFIRM_LINK_HOURS. It replaces any link sent before, so an old one (forwarded, say) can't confirm
  // what anyone may ask for again. Stored hashed, like sign-in links.
  const confirm = randomBytes(32).toString("base64url");
  const { count } = await prisma.changelogSubscriber.updateMany({
    where: { id: subscriber.id, confirmedAt: null },
    data: { confirmTokenHash: hashSecret(confirm), confirmExpiresAt: new Date(Date.now() + CONFIRM_LINK_HOURS * 3_600_000) },
  });
  if (count === 0) {
    // Confirmed meanwhile (by another tab's link): nothing to send.
    return { sentTo: email };
  }
  const url = new URL(`${await portalAddress(projectSlug)}/changelog/subscription`);
  url.searchParams.set("confirm", confirm);
  try {
    await sendEmail({ to: email, ...changelogConfirmEmail({ projectName: project.name, url: url.toString() }), ...(await projectSender(project.id)) });
  } catch (error) {
    log.error("Sending a changelog confirmation failed", { error });
    return { error: "We couldn't send the email. Try again." };
  }
  return { sentTo: email };
}
