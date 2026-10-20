"use server";

import { createHmac } from "node:crypto";

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
  SIGN_IN_LINKS_PER_CLIENT_PER_HOUR,
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

  const requestHeaders = await headers();
  const limited = await recordRequest(project.id, hashSecret(email), await clientHash(requestHeaders));
  if ("error" in limited) {
    return { error: limited.error };
  }
  if (!limited.id) {
    // Over the per-visitor limit: nothing is sent, but the answer is the same, so it tells them nothing.
    return { sentTo: email };
  }
  const metadata: SignInLinkMetadata = {
    linkId: limited.id,
    slug: projectSlug,
    projectName: project.name,
    next: safeRedirectPath(next, "/"),
  };
  try {
    // New accounts are named after the address (they can change it in their account).
    await auth.api.signInMagicLink({ body: { email, name: email.split("@")[0], metadata }, headers: requestHeaders });
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

let warnedNoIpHeader = false;

/**
 * Who's asking, for the per-visitor limit: an HMAC of their IP address (keyed with the
 * auth secret, so the stored hash can't be matched against a list of addresses), read
 * only from TRUSTED_IP_HEADER, a header the proxy sets. Without it there's no
 * per-visitor limit: X-Forwarded-For and the like can be anything the visitor sends.
 */
async function clientHash(requestHeaders: Headers): Promise<string | null> {
  const header = process.env.TRUSTED_IP_HEADER?.trim();
  if (!header) {
    if (!warnedNoIpHeader) {
      warnedNoIpHeader = true;
      log.warn("TRUSTED_IP_HEADER is not set: portal sign-in links have no per-visitor limit");
    }
    return null;
  }
  // The proxy's own value is the last one if it appends to a list.
  const ip = requestHeaders.get(header)?.split(",").at(-1)?.trim();
  return ip ? createHmac("sha256", (await auth.$context).secret).update(ip).digest("hex") : null;
}

/**
 * Counts the request against the hourly limits (per address on any portal, per visitor,
 * and per portal): the new row's id, an error to show, or no id when the visitor is over
 * their limit (which isn't shown).
 */
async function recordRequest(
  projectId: string,
  emailHash: string,
  clientHash: string | null,
): Promise<{ error: string } | { id: string | null }> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.signInLink.deleteMany({ where: { createdAt: { lt: since } } });
  return prisma.$transaction(async (tx) => {
    // One at a time per portal, address and visitor (always in that order), so concurrent
    // requests can't overrun the limits together.
    await lockProject(tx, projectId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${emailHash}))`;
    if (clientHash) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, hashtext(${clientHash}))`;
    }
    const [byAddress, byClient, byPortal] = await Promise.all([
      tx.signInLink.count({ where: { emailHash, createdAt: { gt: since } } }),
      clientHash ? tx.signInLink.count({ where: { clientHash, createdAt: { gt: since } } }) : 0,
      tx.signInLink.count({ where: { projectId, createdAt: { gt: since } } }),
    ]);
    if (byAddress >= SIGN_IN_LINKS_PER_ADDRESS_PER_HOUR) {
      return { error: "We've sent a lot of sign-in links to this address in the last hour. Try again later." };
    }
    // Before the portal's limit, so one visitor can't use it up for everyone.
    if (byClient >= SIGN_IN_LINKS_PER_CLIENT_PER_HOUR) {
      return { id: null };
    }
    if (byPortal >= SIGN_IN_LINKS_PER_PORTAL_PER_HOUR) {
      return { error: "This site has sent a lot of sign-in links in the last hour. Try again later." };
    }
    return tx.signInLink.create({ data: { projectId, emailHash, clientHash }, select: { id: true } });
  });
}
