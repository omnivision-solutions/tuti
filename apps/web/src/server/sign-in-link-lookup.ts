import { createHash } from "node:crypto";

import { prisma } from "@tuti/db";

import { hashSecret } from "@/lib/portal-handoff";

/**
 * A sign-in link that can still be used on this portal, with the address it was
 * sent to (from the stored link, never the URL), or null. Reads only: the token
 * is used up when the person confirms (see emailSignInLink and confirmSignInLink).
 */
export async function pendingSignInLink(projectSlug: string, token: string) {
  if (!token || token.length > 100) {
    return null;
  }
  const [link, verification] = await Promise.all([
    prisma.signInLink.findUnique({
      where: { tokenHash: hashSecret(token) },
      select: { project: { select: { slug: true, name: true } } },
    }),
    // How Better Auth's magic-link plugin stores it with storeToken: "hashed".
    prisma.verification.findFirst({
      where: { identifier: `magic-link:${createHash("sha256").update(token).digest("base64url")}`, expiresAt: { gt: new Date() } },
      select: { value: true },
    }),
  ]);
  if (!link || link.project?.slug !== projectSlug || !verification) {
    return null;
  }
  const { email } = JSON.parse(verification.value) as { email: string };
  return { email, projectName: link.project.name };
}

/** Where a link that didn't work sends people: the sign-in page, to ask for a new one, keeping where they were going. */
export const failedSignInLinkPath = (next: string) =>
  `/sign-in?${new URLSearchParams({ link: "failed", ...(next !== "/" && { next }) })}`;

/**
 * The account a password reset link is for, if the link can still be used on this host
 * (the portal `projectSlug`, or the app host when null), or null. Reads only: the token
 * is used up when the new password is set (see server/password-reset.ts).
 */
export async function pendingPasswordReset(projectSlug: string | null, token: string) {
  if (!token || token.length > 100) {
    return null;
  }
  const [link, verification] = await Promise.all([
    prisma.signInLink.findUnique({ where: { tokenHash: hashSecret(token) }, select: { project: { select: { slug: true } } } }),
    // How Better Auth stores it with verification.storeIdentifier "hashed" (lib/auth.ts).
    prisma.verification.findFirst({
      where: { identifier: createHash("sha256").update(`reset-password:${token}`).digest("base64url"), expiresAt: { gt: new Date() } },
      select: { value: true },
    }),
  ]);
  if (!link || (link.project?.slug ?? null) !== projectSlug || !verification) {
    return null;
  }
  return prisma.user.findUnique({ where: { id: verification.value }, select: { email: true } });
}

/** Where a reset link that didn't work sends people: "Forgot your password?", to ask for a new one. */
export const FAILED_PASSWORD_RESET_PATH = "/forgot-password?link=failed";
