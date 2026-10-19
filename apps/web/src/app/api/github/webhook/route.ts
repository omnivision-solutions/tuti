import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";

import { githubConfig, verifyWebhookSignature } from "@/lib/github";

/**
 * The Tuti App's webhook. Only correctly signed deliveries are read; work beyond
 * bookkeeping goes to background jobs so GitHub gets its answer quickly.
 */
export async function POST(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new Response(null, { status: 404 });
  }
  const body = await request.text();
  if (!verifyWebhookSignature(config.webhookSecret, body, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body) as { action?: string; installation?: { id: number } };

  // Uninstalled (or suspended) on GitHub: the project is no longer connected.
  if (event === "installation" && (payload.action === "deleted" || payload.action === "suspend") && payload.installation) {
    const { count } = await prisma.githubInstallation.deleteMany({ where: { installationId: payload.installation.id } });
    log.info("GitHub installation removed", { installationId: payload.installation.id, projects: count });
  }
  return Response.json({ ok: true });
}
