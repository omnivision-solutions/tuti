"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { changelogReach, projectEmailWaits, reached } from "@tuti/jobs";
import { headers } from "next/headers";
import { z } from "zod";

import { emailConfirmation } from "./changelog-subscription";
import { countEmailedLink } from "./email-link-limits";

const fields = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")) });

/**
 * "Get updates by email" on a portal's changelog: emails a link to confirm (double opt-in), so nothing else is sent
 * until the address's owner confirms. Counted with the other emailed links' limits. Says the same whether or not the
 * address gets it already (which gets nothing), so it tells nobody who's subscribed. Public portals only:
 * a private one's entries are for its readers, and an address can't show it's one. Nothing is sent while the project's
 * email is paused (its bounces or complaints went over): typed-in addresses are what bounce.
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
    select: { id: true, email: true, confirmedAt: true },
  });
  // Already getting it (changelogReach), or the project's email is paused: nothing to send (the same answer).
  const reach = await changelogReach(project.id, { email, confirmed: subscriber.confirmedAt !== null });
  if (reached(reach) || (await projectEmailWaits(project.id))) {
    return { sentTo: email };
  }
  // A new one, one not confirmed (asked before, or unsubscribed since), or one who's turned all of the project's
  // emails off (their link offers to turn them back on): a link of this request's own (emailConfirmation).
  const sent = await emailConfirmation({ ...project, slug: projectSlug }, subscriber);
  return sent.error ? { error: sent.error } : { sentTo: email };
}
