"use server";

import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { resolveHost } from "@/lib/hosts";

import { countEmailedLink } from "./email-link-limits";
import { FAILED_PASSWORD_RESET_PATH, pendingPasswordReset } from "./sign-in-link-lookup";

/*
 * "Forgot your password?" on the app and on portals, with Better Auth's reset flow
 * (lib/auth.ts). Each link is bound to the host it was asked on: the portal (whose
 * sign_in_link row has its project) or the app host (no project). The account is the
 * same everywhere, so a new password works on the app and on every portal.
 */

const fields = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email("Enter a valid email address")) });

/** The portal's slug, null on the app host, undefined anywhere else. */
async function thisHost(): Promise<{ requestHeaders: Headers; slug: string | null | undefined }> {
  const requestHeaders = await headers();
  const target = resolveHost(requestHeaders.get("host"));
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
  const project = slug ? await prisma.project.findUnique({ where: { slug }, select: { id: true } }) : null;
  if (slug === undefined || (slug && !project)) {
    return unavailable;
  }

  const limited = await countEmailedLink(project?.id ?? null, email, requestHeaders);
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
 * "Set new password" on the page a reset link opens (/reset-password): uses the token
 * up, signs the account out everywhere and marks its email verified (lib/auth.ts), then
 * goes to sign in with the new password. A dead link, or one from another host, goes
 * back to "Forgot your password?".
 *
 * Returns where to go rather than redirecting: Next.js renders a server action's redirect
 * by fetching the path from its own origin, past proxy.ts, so on a portal it would get
 * the app's page of the same name.
 */
export async function setNewPassword(form: FormData): Promise<{ error: string } | { location: string }> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) {
    return { error: "The passwords don't match." };
  }
  // Bound to the host this request came to, never a form field.
  const { slug } = await thisHost();
  let changed = false;
  if (slug !== undefined && (await pendingPasswordReset(slug, token))) {
    try {
      await auth.api.resetPassword({ body: { token, newPassword: password } });
      changed = true;
    } catch (error) {
      if (!(error instanceof APIError)) {
        throw error;
      }
      // Too short or long: checked before the token is used, so they can try again.
      if (error.body?.code?.startsWith("PASSWORD_TOO_")) {
        return { error: error.message };
      }
      // Otherwise used up since the check: the same as any other dead link.
    }
  }
  return { location: changed ? "/sign-in?reset=done" : FAILED_PASSWORD_RESET_PATH };
}
