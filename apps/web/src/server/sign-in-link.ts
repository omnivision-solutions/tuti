"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { headers } from "next/headers";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { hashSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";
import {
  SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR,
  SIGN_IN_LINKS_PER_PORTAL_PER_HOUR,
  type SignInLinkMetadata,
} from "@/lib/sign-in-link";

const fields = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")) });

/**
 * "Email me a sign-in link" on a portal (see lib/sign-in-link.ts). Says the same
 * whether or not the address has an account; opening the link creates one if not.
 * `next` is where to go afterwards (a path on this portal).
 */
export async function emailSignInLink(
  projectSlug: string,
  next: string,
  form: FormData,
): Promise<{ error?: string; sentTo?: string }> {
  if (!emailConfigured()) {
    return { error: "Sign-in links aren't available here." };
  }
  const parsed = fields.safeParse({ email: form.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const { email } = parsed.data;
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true } });
  if (!project) {
    return { error: "Project not found." };
  }

  const limited = await recordRequest(project.id, hashSecret(email));
  if (typeof limited === "string") {
    return { error: limited };
  }
  const metadata: SignInLinkMetadata = {
    linkId: limited.id,
    slug: projectSlug,
    projectName: project.name,
    next: safeRedirectPath(next, "/"),
  };
  try {
    // New accounts are named after the address (they can change it in their account).
    await auth.api.signInMagicLink({ body: { email, name: email.split("@")[0], metadata }, headers: await headers() });
  } catch (error) {
    log.error("Sending a sign-in link failed", { error });
    return { error: "We couldn't send the email. Try again." };
  }
  return { sentTo: email };
}

/** Counts the request against the hourly limits (per address on any portal, and per portal), or says which one it's over. */
async function recordRequest(projectId: string, emailHash: string) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.signInLink.deleteMany({ where: { createdAt: { lt: since } } });
  return prisma.$transaction(async (tx) => {
    // One at a time per portal and per address, so concurrent requests can't overrun the limits together.
    await lockProject(tx, projectId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${emailHash}))`;
    const [byAddress, byPortal] = await Promise.all([
      tx.signInLink.count({ where: { emailHash, createdAt: { gt: since } } }),
      tx.signInLink.count({ where: { projectId, createdAt: { gt: since } } }),
    ]);
    if (byAddress >= SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR) {
      return "We've sent a lot of sign-in links to this address in the last hour. Try again later.";
    }
    if (byPortal >= SIGN_IN_LINKS_PER_PORTAL_PER_HOUR) {
      return "This site has sent a lot of sign-in links in the last hour. Try again later.";
    }
    return tx.signInLink.create({ data: { projectId, emailHash }, select: { id: true } });
  });
}
