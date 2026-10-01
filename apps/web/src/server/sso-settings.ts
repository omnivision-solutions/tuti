"use server";

import { prisma } from "@tuti/db";
import { refresh } from "next/cache";

import { generateSsoSecret } from "@/lib/sso";

import { getAdminWorkspace } from "./members";

export type RotateSsoSecretState = { error?: string; secret?: string };

/** Enables SSO or replaces the secret. The new secret is only ever returned here, once. */
export async function rotateSsoSecret(workspaceSlug: string): Promise<RotateSsoSecretState> {
  const workspace = await getAdminWorkspace(workspaceSlug);
  if (!workspace) {
    return { error: "Only workspace owners and admins can change SSO settings" };
  }
  const secret = generateSsoSecret();
  await prisma.workspace.update({ where: { id: workspace.id }, data: { ssoSecret: secret } });
  refresh();
  return { secret };
}

export async function disableSso(workspaceSlug: string): Promise<{ error?: string }> {
  const workspace = await getAdminWorkspace(workspaceSlug);
  if (!workspace) {
    return { error: "Only workspace owners and admins can change SSO settings" };
  }
  await prisma.workspace.update({ where: { id: workspace.id }, data: { ssoSecret: null } });
  refresh();
  return {};
}
