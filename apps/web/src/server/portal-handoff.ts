"use server";

import { prisma } from "@tuti/db";
import { redirect } from "next/navigation";

import { portalAddress } from "@/server/custom-domains";
import { HANDOFF_TTL_SECONDS, hashSecret, isSecret, randomSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";

import { getAccountSession } from "./session";

/**
 * "Continue as <name>" on the app host: issues a one-time code for the signed-in
 * account and sends the browser back to the portal that asked (see lib/portal-handoff.ts).
 */
export async function continueToPortal(projectSlug: string, state: string, redirectPath: string) {
  const session = await getAccountSession();
  if (!session) {
    return { error: "Sign in to continue." };
  }
  if (!isSecret(state)) {
    return { error: "This sign-in link isn't valid. Go back to the portal and try again." };
  }
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true } });
  if (!project) {
    return { error: "Project not found." };
  }

  const code = randomSecret();
  await prisma.portalHandoff.create({
    data: {
      codeHash: hashSecret(code),
      projectId: project.id,
      userId: session.user.id,
      stateHash: hashSecret(state),
      expiresAt: new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000),
    },
  });
  // After the address: it can have a path (a portal under its site's /portal).
  const callback = new URL(`${await portalAddress(projectSlug)}/api/auth/continue/callback`);
  callback.searchParams.set("code", code);
  callback.searchParams.set("redirect", safeRedirectPath(redirectPath, "/"));
  redirect(callback.toString());
}
