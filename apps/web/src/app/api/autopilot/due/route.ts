import { timingSafeEqual } from "node:crypto";

import { autopilotDueToken } from "@tuti/jobs";

import { runDueAutopilot } from "@/server/operations/code-changes";

/**
 * Applies Autopilot's due updates (its hold is over): the worker's autopilot-due calls this every
 * minute with a token from the server's secret, since applying is the web app's (posts, comments and
 * articles saved as the team saves them). Anyone else gets a 401.
 */
export async function POST(request: Request) {
  const token = autopilotDueToken();
  const sent = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  if (!token || sent.length !== token.length || !timingSafeEqual(sent, Buffer.from(token))) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  return Response.json(await runDueAutopilot());
}
