"use server";

import { prisma } from "@tuti/db";
import { refresh } from "next/cache";

import { generateSsoSecret } from "@/lib/sso";

import { getAdminProject } from "./membership";

export type RotateSsoSecretState = { error?: string; secret?: string };

/** Enables SSO or replaces the secret. The new secret is only ever returned here, once. */
export async function rotateSsoSecret(projectSlug: string): Promise<RotateSsoSecretState> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can change SSO settings" };
  }
  const secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
  refresh();
  return { secret };
}

export async function disableSso(projectSlug: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can change SSO settings" };
  }
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: null } });
  refresh();
  return {};
}
