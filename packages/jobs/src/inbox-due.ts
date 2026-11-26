import { createHmac } from "node:crypto";

import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";

/** What the worker sends the web app to run the inbox's path left behind (POST /api/inbox/due): from the server's secret, never sent anywhere else. */
export function inboxDueToken(): string | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret ? createHmac("sha256", secret).update("inbox-due").digest("hex") : null;
}

/**
 * The worker's minute: asks the web app to run what the inbox's path left behind (`conversation.pathDueAt`: a deploy or
 * a crash between a message and its checks), as autopilot-due does. The web app runs it: the checks are its code.
 */
export async function inboxDue(): Promise<{ checked: number } | { skipped: true }> {
  const token = inboxDueToken();
  if (!process.env.APP_URL || !token) {
    if ((await prisma.conversation.count({ where: { pathDueAt: { lte: new Date() } } })) > 0) {
      log.error("The inbox can't run what's left of its path: set APP_URL and BETTER_AUTH_SECRET on the worker (the web app's values)");
    }
    return { skipped: true };
  }
  const response = await fetch(new URL("/api/inbox/due", process.env.APP_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(55_000),
  });
  if (!response.ok) {
    throw new Error(`The web app answered ${response.status} to /api/inbox/due`);
  }
  return (await response.json()) as { checked: number };
}
