"use server";

import { randomBytes } from "node:crypto";

import { prisma } from "@tuti/db";
import { checkWebhookUrl } from "@tuti/shared/webhook-url";
import { refresh } from "next/cache";
import { z } from "zod";

import { WEBHOOK_EVENTS } from "@/lib/webhook-events";

import { emitEvent } from "./events";
import { getAdminProject } from "./membership";
import { getAccountSession } from "./session";

const MAX_WEBHOOKS = 10;
const DENIED = "Only project owners and admins can manage webhooks";

const createSchema = z.object({
  url: z.string().trim().max(2048),
  events: z
    .array(z.enum(Object.keys(WEBHOOK_EVENTS) as [keyof typeof WEBHOOK_EVENTS]))
    .min(1, "Pick at least one event"),
});

/** Adds a webhook. Its signing secret is only ever returned here, once. */
export async function createWebhook(
  projectSlug: string,
  url: string,
  events: string[],
): Promise<{ error?: string; secret?: string }> {
  const [project, session] = await Promise.all([getAdminProject(projectSlug), getAccountSession()]);
  if (!project || !session) {
    return { error: DENIED };
  }
  const parsed = createSchema.safeParse({ url, events: [...new Set(events)] });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await checkWebhookUrl(parsed.data.url);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if ((await prisma.webhook.count({ where: { projectId: project.id } })) >= MAX_WEBHOOKS) {
    return { error: `A project can have up to ${MAX_WEBHOOKS} webhooks` };
  }

  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  await prisma.webhook.create({
    data: { projectId: project.id, url: parsed.data.url, events: parsed.data.events, secret, createdById: session.user.id },
  });
  refresh();
  return { secret };
}

export async function deleteWebhook(projectSlug: string, webhookId: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: DENIED };
  }
  const { count } = await prisma.webhook.deleteMany({ where: { id: String(webhookId), projectId: project.id } });
  if (count === 0) {
    return { error: "Webhook not found" };
  }
  refresh();
  return {};
}

/** Sends a `ping` event to one webhook, to check the endpoint and its signature check. */
export async function sendTestWebhook(projectSlug: string, webhookId: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: DENIED };
  }
  const webhook = await prisma.webhook.findFirst({ where: { id: String(webhookId), projectId: project.id }, select: { id: true } });
  if (!webhook) {
    return { error: "Webhook not found" };
  }
  await emitEvent(project.id, "ping", { message: "Hello from Tuti" }, { only: webhook.id });
  refresh();
  return {};
}
