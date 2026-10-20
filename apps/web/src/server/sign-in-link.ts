"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { resolveHost } from "@/lib/hosts";
import { hashSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";
import {
  SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR,
  SIGN_IN_LINKS_PER_PORTAL_PER_HOUR,
  type SignInLinkMetadata,
} from "@/lib/sign-in-link";

import { failedSignInLinkPath, pendingSignInLink } from "./sign-in-link-lookup";

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

/**
 * "Sign in" on the page a sign-in link opens (/sign-in/link): uses the token up and
 * signs the person in on this portal (making their account if it's new), then goes
 * to `next`. A button rather than the link itself, so mail scanners that open links
 * can't use it up, and so people see whose account they're signing in to.
 */
export async function confirmSignInLink(form: FormData) {
  const token = String(form.get("token") ?? "");
  const next = safeRedirectPath(String(form.get("next") ?? ""), "/");
  const requestHeaders = await headers();
  // The portal is the one this request came to (the session cookie is set there), never a form field.
  const target = resolveHost(requestHeaders.get("host"));
  let signedIn = false;
  if (target.kind === "portal" && (await pendingSignInLink(target.slug, token))) {
    try {
      // Better Auth uses the token up (once, if still fresh), makes the account if needed and sets the cookie.
      await auth.api.magicLinkVerify({ query: { token }, headers: requestHeaders });
      signedIn = true;
    } catch (error) {
      // Used up or expired since the check (Better Auth's redirect error): the same as any other dead link.
      if (!(error instanceof APIError)) {
        log.error("Signing in with a sign-in link failed", { error });
      }
    }
  }
  redirect(signedIn ? next : failedSignInLinkPath(next));
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
