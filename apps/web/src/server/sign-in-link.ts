"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { requestTarget } from "@/server/custom-domains";
import { safeRedirectPath } from "@/lib/redirects";
import type { SignInLinkMetadata } from "@/lib/sign-in-link";

import { countEmailedLink } from "./email-link-limits";
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
  const limited = await countEmailedLink(project.id, email, requestHeaders);
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
 * signs the person in on this portal (making their account if it's new), and says
 * where to go: `next`, or back to sign-in if the link was dead. A button rather than
 * the link itself, so mail scanners that open links can't use it up, and so people see
 * whose account they're signing in to.
 *
 * The browser goes there itself (SignInLinkConfirm): a server action's redirect is
 * rendered from the app's own routes, not the portal's, so "/" would be Tuti's home page.
 */
export async function confirmSignInLink(form: FormData): Promise<{ location: string }> {
  const token = String(form.get("token") ?? "");
  const next = safeRedirectPath(String(form.get("next") ?? ""), "/");
  const requestHeaders = await headers();
  // The portal is the one this request came to (the session cookie is set there), never a form field.
  const target = await requestTarget(requestHeaders.get("host"));
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
  return { location: signedIn ? next : failedSignInLinkPath(next) };
}
