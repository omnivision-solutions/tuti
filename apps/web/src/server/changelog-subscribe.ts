"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { changelogReach, projectEmailWaits, reached } from "@tuti/jobs";
import { isLanguage } from "@tuti/shared";
import { headers } from "next/headers";
import { z } from "zod";

import { emailConfirmation } from "./changelog-subscription";
import { mayRead } from "./portal-access";
import { countEmailedLink } from "./email-link-limits";
import { portalLanguage } from "./portal-base";
import { subscriberLanguage } from "./portal-language";
import { sessionIn } from "./session";

const fields = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")) });

/**
 * "Get updates by email" on a portal's changelog: emails a link to confirm (double opt-in), so nothing else is sent
 * until the address's owner confirms. Counted with the other emailed links' limits. Says the same whether or not the
 * address gets it already (which gets nothing), so it tells nobody who's subscribed. On a private portal, for its readers
 * (signed in), and to an address that's one of them only (changelogReach's "private": nothing sent, the same answer):
 * its entries are for them. Nothing is sent while the project's
 * email is paused (its bounces or complaints went over): typed-in addresses are what bounce.
 */
export async function subscribeToChangelog(projectSlug: string, form: FormData): Promise<{ error?: string; sentTo?: string }> {
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true, portalAccess: true } });
  if (!project || !emailConfigured() || (project.portalAccess !== "PUBLIC" && !(await mayRead(project.id)))) {
    return { error: "Updates by email aren't available here." };
  }
  const parsed = fields.safeParse({ email: form.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const { email } = parsed.data;
  // Already getting it (changelogReach), or the project's email is paused: nothing to send (the same answer), so
  // counted as sending nothing.
  const existing = await prisma.changelogSubscriber.findUnique({ where: { projectId_email: { projectId: project.id, email } }, select: { confirmedAt: true } });
  const reach = await changelogReach(project.id, { email, confirmed: !!existing?.confirmedAt });
  // Not to an address that would get nothing confirmed: a private portal's, not one of its readers.
  const forReaders = (await changelogReach(project.id, { email, confirmed: true })) !== "private";
  const sends = !reached(reach) && forReaders && !(await projectEmailWaits(project.id));
  const limited = await countEmailedLink(project.id, email, await headers(), sends ? "address" : "nobody");
  if ("error" in limited) {
    return { error: limited.error };
  }
  if (!limited.id) {
    // Over the per-visitor limit: nothing is sent, but the answer is the same, so it tells them nothing.
    return { sentTo: email };
  }
  // No row for nothing sent: one with no link out reads as unsubscribed (S2's migration), which the team can't add.
  if (!sends) {
    return { sentTo: email };
  }
  // The language of the page they subscribed on (docs/plan.md L16): a language's own address ("/de/changelog"); on the
  // default language's, a signed-in reader's saved one, else the default's (null). Their emails come in it where the entry is translated.
  const { language: address, prefix } = await portalLanguage();
  const session = prefix ? null : await sessionIn(project.id);
  const language = prefix && address && isLanguage(address) ? address : session ? ((await subscriberLanguage(project.id, session.user.id)) ?? null) : null;
  const subscriber = await prisma.changelogSubscriber.upsert({
    where: { projectId_email: { projectId: project.id, email } },
    create: { projectId: project.id, email, language },
    update: {},
    select: { id: true, email: true, confirmedAt: true },
  });
  // Asked again before it's confirmed: the page it's asked on now. A confirmed one keeps its own: an address anyone can
  // type never changes the language someone already receives in (their switch, signed in, does).
  if (!subscriber.confirmedAt) {
    await prisma.changelogSubscriber.updateMany({ where: { id: subscriber.id, confirmedAt: null }, data: { language } });
  }
  // A new one, one not confirmed (asked before, or unsubscribed since), or one who's turned all of the project's
  // emails off (their link offers to turn them back on): a link of this request's own (emailConfirmation).
  const sent = await emailConfirmation({ ...project, slug: projectSlug }, subscriber);
  return sent.error ? { error: sent.error } : { sentTo: email };
}
