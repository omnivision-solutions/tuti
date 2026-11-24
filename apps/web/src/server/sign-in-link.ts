"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import { APIError } from "better-auth/api";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { cookies, headers } from "next/headers";
import { z } from "zod";

import { appSignInReturn, isAppSignInState } from "@/lib/app-sign-in";
import { auth } from "@/lib/auth";
import { requestTarget } from "@/server/custom-domains";
import { safeRedirectPath } from "@/lib/redirects";
import type { SignInLinkMetadata } from "@/lib/sign-in-link";

import { countEmailedLink } from "./email-link-limits";
import { failedSignInLinkPath, pendingSignInLink } from "./sign-in-link-lookup";

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

/**
 * "Open the app" on the page the mobile app's sign-in link opens (/app/auth/app-link, lib/app-sign-in.ts): uses the
 * token up, starts a session for the account and says where the browser goes: the app, through its link scheme, with
 * the session's cookie for it to keep (Better Auth's Expo plugin adds it to that redirect) and the `state` the app asked
 * with. A dead link sends the app `error` instead. The session is the app's alone: this browser, which may be anyone's
 * (a link opened at a desk), is signed in as it was before, or not at all. Null: nothing to open (not the app's host,
 * or no state of the app's).
 */
export async function confirmAppSignInLink(form: FormData): Promise<{ location: string | null }> {
  const token = String(form.get("token") ?? "");
  const state = form.get("state");
  const requestHeaders = await headers();
  if (!isAppSignInState(state) || (await requestTarget(requestHeaders.get("host"))).kind !== "app") {
    return { location: null };
  }
  const back = appSignInReturn(state);
  if (!(await pendingSignInLink(null, token))) {
    return { location: `${back}&error=INVALID_TOKEN` };
  }
  const browser = await cookies();
  const before = new Map(browser.getAll().map((cookie) => [cookie.name, cookie.value]));
  // Better Auth uses the token up (once, if still fresh) and answers with the redirect; used up since the check, its
  // redirect has `error`, as above.
  const response = await auth.api.magicLinkVerify({ query: { token, callbackURL: back }, headers: requestHeaders, asResponse: true });
  // Better Auth also set the session's cookies on this browser (its Next.js plugin, for every sign-in): each goes back to
  // what it was, so whoever was signed in here still is, and nobody is otherwise.
  for (const [name, cookie] of parseSetCookieHeader(response.headers.get("set-cookie") ?? "")) {
    const was = before.get(name);
    browser.set(name, was ?? "", { ...toCookieOptions(cookie), ...(was === undefined && { maxAge: 0 }) });
  }
  return { location: response.headers.get("location") };
}
