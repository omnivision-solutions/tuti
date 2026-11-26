import { timingSafeEqual } from "node:crypto";

import { inboxDueToken } from "@tuti/jobs";

import { runDueInbox } from "@/server/spam-models";

/**
 * Runs what the inbox's path left behind (`conversation.pathDueAt`: a deploy or a crash before the spam filter's model
 * checks ran): the worker's inbox-due calls this every minute with a token from the server's secret, as autopilot-due
 * does, since the checks are the web app's. Anyone else gets a 401.
 */
export async function POST(request: Request) {
  const token = inboxDueToken();
  const sent = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  if (!token || sent.length !== token.length || !timingSafeEqual(sent, Buffer.from(token))) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  return Response.json(await runDueInbox());
}
