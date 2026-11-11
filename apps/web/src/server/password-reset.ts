"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { z } from "zod";

import { auth, signedWayBack } from "@/lib/auth";
import { requestTarget } from "@/server/custom-domains";

import { countEmailedLink } from "./email-link-limits";
import { FAILED_PASSWORD_RESET_PATH, pendingPasswordReset } from "./sign-in-link-lookup";

/*
 * "Forgot your password?" with Better Auth's reset flow (lib/auth.ts). It can be asked for a
 * portal, on the portal or on the app on the way back to one (the sign_in_link row has its
 * project, for the email's sender and the way back), but every link opens on the app's host and
 * the password is set there only: the account is the same everywhere, and a portal's team may
 * run its portal's host. The app never sends anyone to that host by itself (see setNewPassword).
 */

const fields = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")) });

/** The portal's slug, null on the app host, undefined anywhere else. */
async function thisHost(): Promise<{ requestHeaders: Headers; slug: string | null | undefined }> {
  const requestHeaders = await headers();
  const target = await requestTarget(requestHeaders.get("host"));
  return { requestHeaders, slug: target.kind === "portal" ? target.slug : target.kind === "app" ? null : undefined };
}

/**
 * Emails a link to set a new password, for this host. Answers the same whether or not
 * the address has an account, so it can't be used to find accounts.
 */
export async function emailPasswordReset(form: FormData): Promise<{ error?: string; sentTo?: string }> {
  const unavailable = { error: "Password resets aren't available here." };
  if (!emailConfigured()) {
    return unavailable;
  }
  const parsed = fields.safeParse({ email: form.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message };
  }
  const { email } = parsed.data;
  const { requestHeaders, slug } = await thisHost();
  if (slug === undefined) {
    return unavailable;
  }
  // On the app, on the way back to a portal (its sign-in's "Forgot your password?"): asked for that portal, so the email
  // comes from it and the way back after leads there. The form stays on the app.
  const portal = slug ?? (typeof form.get("portal") === "string" ? (form.get("portal") as string) : null);
  const project = portal ? await prisma.project.findUnique({ where: { slug: portal }, select: { id: true } }) : null;
  if (slug && !project) {
    return unavailable;
  }

  // An address with no account gets nothing, so it's counted as sending nothing (the answer's the same).
  const account = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const limited = await countEmailedLink(project?.id ?? null, email, requestHeaders, account ? "address" : "nobody");
  if ("error" in limited) {
    return limited;
  }
  if (limited.id) {
    try {
      // Sends nothing for an unknown address. The row's id tells sendPasswordReset (lib/auth.ts) the host.
      await auth.api.requestPasswordReset({ body: { email, redirectTo: limited.id } });
    } catch (error) {
      // Only an address with an account gets this far, so the answer stays the same.
      log.error("Sending a password reset link failed", { error });
    }
  }
  return { sentTo: email };
}

/**
 * "Set new password" on the page a reset link opens (the app's /reset-password): uses the
 * token up, signs the account out everywhere and marks its email verified (lib/auth.ts),
 * then goes to the app's sign-in with the new password; for a portal's, on to the "Continue to
 * <project>" card (its address, and a click). A dead link, or a request to any host but the
 * app's, goes back to the app's "Forgot your password?".
 */
export async function setNewPassword(form: FormData): Promise<{ error: string } | { location: string }> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) {
    return { error: "The passwords don't match." };
  }
  const reset = (await thisHost()).slug === null ? await pendingPasswordReset(token) : null;
  if (!reset) {
    return { location: FAILED_PASSWORD_RESET_PATH };
  }
  try {
    await auth.api.resetPassword({ body: { token, newPassword: password } });
  } catch (error) {
    if (!(error instanceof APIError)) {
      throw error;
    }
    // Too short or long: checked before the token is used, so they can try again.
    if (error.body?.code?.startsWith("PASSWORD_TOO_")) {
      return { error: error.message };
    }
    // Otherwise used up since the check: the same as any other dead link.
    return { location: FAILED_PASSWORD_RESET_PATH };
  }
  // Signing in with it on the app, saying it's changed. Asked for a portal: then the "Continue to <project>" card, with the
  // portal's address, for this account to click on; never off the app by itself (a team may run that address).
  const next = reset.askedOn ? await signedWayBack(reset.askedOn, "/", reset.userId) : null;
  return { location: `/app/auth/sign-in?${new URLSearchParams({ reset: "done", ...(next && { next }) })}` };
}
