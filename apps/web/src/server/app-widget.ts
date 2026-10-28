"use server";

import { prisma } from "@tuti/db";
import { SignJWT } from "jose";

import { appWidgetProject } from "@/lib/app-portal";

import { getAccountSession } from "./session";

/**
 * A sign-in token for Tuti's own widget in the team app (APP_WIDGET_PROJECT; components/app-widget.tsx),
 * made as any app signs its users in to its widget (docs/sso.md): signed with that project's SSO
 * secret, the account's id as `sub`. None while that project has SSO off: the widget is signed out.
 */
export async function appWidgetToken(): Promise<{ token?: string; error?: string }> {
  const session = await getAccountSession();
  if (!session) {
    return { error: "Sign in to Tuti first" };
  }
  const slug = appWidgetProject();
  const project = slug ? await prisma.project.findUnique({ where: { slug }, select: { ssoSecret: true } }) : null;
  if (!project?.ssoSecret) {
    return {};
  }
  const { user } = session;
  const token = await new SignJWT({
    name: user.name,
    // Only a verified address gets the project's emails.
    ...(user.emailVerified && { email: user.email }),
    ...(user.image?.startsWith("https://") && { avatar: user.image }),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(project.ssoSecret));
  return { token };
}
