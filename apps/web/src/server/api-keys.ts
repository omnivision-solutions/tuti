"use server";

import { prisma } from "@tuti/db";
import { refresh } from "next/cache";
import { z } from "zod";

import { apiKeyPrefix, generateApiKey, hashApiKey } from "@/lib/api-keys";

import { getAdminProject } from "./membership";
import { getAccountSession } from "./session";

const MAX_KEYS = 25;

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(60, "Keep the name under 60 characters"),
  scope: z.enum(["READ", "WRITE"]),
});

/** Creates an API key. The key is only ever returned here, once. */
export async function createApiKey(
  projectSlug: string,
  name: string,
  scope: string,
): Promise<{ error?: string; key?: string }> {
  const [project, session] = await Promise.all([getAdminProject(projectSlug), getAccountSession()]);
  if (!project || !session) {
    return { error: "Only project owners and admins can manage API keys" };
  }
  const parsed = createSchema.safeParse({ name, scope });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const active = await prisma.apiKey.count({ where: { projectId: project.id, revokedAt: null } });
  if (active >= MAX_KEYS) {
    return { error: `A project can have up to ${MAX_KEYS} keys. Revoke one you don't use.` };
  }

  const key = generateApiKey();
  await prisma.apiKey.create({
    data: {
      projectId: project.id,
      name: parsed.data.name,
      scope: parsed.data.scope,
      keyHash: hashApiKey(key),
      prefix: apiKeyPrefix(key),
      createdById: session.user.id,
    },
  });
  refresh();
  return { key };
}

/** Revoked keys stop working at once and can't be brought back. */
export async function revokeApiKey(projectSlug: string, keyId: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can manage API keys" };
  }
  const { count } = await prisma.apiKey.updateMany({
    where: { id: String(keyId), projectId: project.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) {
    return { error: "Key not found" };
  }
  refresh();
  return {};
}
