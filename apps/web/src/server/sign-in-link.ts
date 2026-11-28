"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { z } from "zod";

import { auth } from "@/server/auth/auth";
import { requestTarget } from "@/server/custom-domains";
import { safeRedirectPath } from "@/lib/redirects";
import type { SignInLinkMetadata } from "@/lib/sign-in-link";

import { countEmailedLink } from "./email-link-limits";
import { failedSignInLinkPath, pendingSignInLink } from "./sign-in-link-lookup";
import { portalLanguage } from "@/server/portal-base";
import { rememberPageLanguage } from "@/server/portal-language";

const fields = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")),
  // A portal's sign-up: the new account's name.
  name: z.string().trim().min(1, "Enter your name").max(100, "Keep your name under 100 characters").optional(),
});

/**
 * "Email me a sign-in link" on a portal (see lib/sign-in-link.ts). Says the same
 * whether or not the address has an account; opening the link creates one if not, named
 * `name` from the portal's sign-up (an existing account keeps its own: Better Auth only names new ones).
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
  const parsed = fields.safeParse({ email: form.get("email"), name: form.get("name") ?? undefined });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const { email, name } = parsed.data;
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
    // The link opens at this page's language address (its dead-link fallback, through the page's links, too), and the
    // email is in its language.
    ...(({ prefix, language }) => ({ prefix, language: language ?? undefined }))(await portalLanguage()),
  };
  try {
    // New accounts are named as typed on sign-up, else after the address (they can change it in their account).
    await auth.api.signInMagicLink({ body: { email, name: name ?? email.split("@")[0], metadata }, headers: requestHeaders });
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
  const pending = target.kind === "portal" ? await pendingSignInLink(target.slug, token) : null;
  if (pending) {
    try {
      // Better Auth uses the token up (once, if still fresh), makes the account if needed and sets the cookie.
      await auth.api.magicLinkVerify({ query: { token }, headers: requestHeaders });
      signedIn = true;
      // The link opens at the language address it was asked at: their emails' language, where they have none.
      const [account, project] = await Promise.all([
        prisma.user.findFirst({ where: { email: { equals: pending.email, mode: "insensitive" } }, select: { id: true } }),
        prisma.project.findUnique({ where: { slug: (target as { slug: string }).slug }, select: { id: true } }),
      ]);
      if (account && project) {
        await rememberPageLanguage({ kind: "user", userId: account.id }, account.id, project.id);
      }
    } catch (error) {
      // Used up or expired since the check (Better Auth's redirect error): the same as any other dead link.
      if (!(error instanceof APIError)) {
        log.error("Signing in with a sign-in link failed", { error });
      }
    }
  }
  return { location: signedIn ? next : failedSignInLinkPath(next) };
}
