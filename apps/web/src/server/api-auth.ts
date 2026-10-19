import { prisma } from "@tuti/db";

import { API_RATE_LIMIT, hashApiKey } from "@/lib/api-keys";

import type { ApiKeyActor } from "./operations";

/** Errors from the API and MCP endpoints: `{ "error": { "code", "message" } }`. */
export function apiError(status: number, code: string, message: string, headers?: Record<string, string>) {
  return Response.json({ error: { code, message } }, { status, headers });
}

/** The key's actor, or the error response. Counts the request against the key's rate limit. */
export async function authenticate(request: Request): Promise<ApiKeyActor | Response> {
  const key = /^Bearer (tuti_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!key) {
    return apiError(401, "unauthorized", "Send a project API key: Authorization: Bearer tuti_…");
  }
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  // Atomic: counts this request in the key's current minute (starting a new one if needed).
  const [found] = await prisma.$queryRaw<
    { id: string; projectId: string; scope: "READ" | "WRITE"; createdById: string; rateCount: number }[]
  >`
    UPDATE api_key
    SET "rateCount" = CASE WHEN "rateWindowStart" = ${window} THEN "rateCount" + 1 ELSE 1 END,
        "rateWindowStart" = ${window},
        "lastUsedAt" = now()
    WHERE "keyHash" = ${hashApiKey(key)} AND "revokedAt" IS NULL
    RETURNING id, "projectId", scope, "createdById", "rateCount"`;
  if (!found) {
    return apiError(401, "unauthorized", "This API key isn't valid or was revoked");
  }
  if (found.rateCount > API_RATE_LIMIT) {
    const retryAfter = Math.ceil((window.getTime() + 60_000 - Date.now()) / 1000);
    return apiError(429, "rate_limited", `Up to ${API_RATE_LIMIT} requests a minute per key`, {
      "Retry-After": String(retryAfter),
    });
  }
  return {
    kind: "apiKey",
    keyId: found.id,
    projectId: found.projectId,
    scope: found.scope === "WRITE" ? "write" : "read",
    createdById: found.createdById,
  };
}

