import { z } from "zod";

import { refreshLicense } from "@/server/license-server";

/**
 * Tuti's licence server: installations renew each licensed project's key here, daily (see
 * server/license-server.ts). Only on Tuti's own installation; a 404 everywhere else.
 */
const headers = { "cache-control": "no-store" };

const id = z.string().min(1).max(100);
const body = z.object({
  installation: id,
  project: id,
  token: id.nullable(),
  requestId: z.string().min(16).max(100),
  version: z.string().max(50).optional(),
});

const MESSAGES = {
  not_licensed: "This project has no licence on this installation",
  in_use: "This licence is in use on another installation",
};

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input", message: "Send installation, project, token and requestId" }, { status: 400, headers });
  }
  const result = await refreshLicense(parsed.data);
  if (!result) {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }
  if ("error" in result) {
    return Response.json({ error: result.error, message: MESSAGES[result.error] }, { status: 403, headers });
  }
  return Response.json({ key: result.key, token: result.token, now: result.now.toISOString() }, { headers });
}
