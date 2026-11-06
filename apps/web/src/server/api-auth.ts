import { prisma, type TeamRole } from "@tuti/db";

import { API_RATE_LIMIT, hashApiKey } from "@/lib/api-keys";

import type { ApiKeyActor, Operation } from "./operations";

/** A key's actor, with its creator's current role in the key's project: a key acts with their powers, only while they have them. */
export type ApiKey = ApiKeyActor & { role: TeamRole };

/** Errors from the API and MCP endpoints: `{ "error": { "code", "message" } }`. */
export function apiError(status: number, code: string, message: string, headers?: Record<string, string>) {
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * The key's actor, or the error response. Counts the request against the key's rate limit. A key stops working once
 * whoever created it leaves the project's team.
 */
export async function authenticate(request: Request): Promise<ApiKey | Response> {
  const key = /^Bearer (tuti_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!key) {
    return apiError(401, "unauthorized", "Send a project API key: Authorization: Bearer tuti_…");
  }
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  // Atomic: counts this request in the key's current minute (starting a new one if needed).
  const [found] = await prisma.$queryRaw<
    { id: string; projectId: string; scope: "READ" | "WRITE"; createdById: string; rateCount: number; role: TeamRole | null }[]
  >`
    UPDATE api_key
    SET "rateCount" = CASE WHEN "rateWindowStart" = ${window} THEN "rateCount" + 1 ELSE 1 END,
        "rateWindowStart" = ${window},
        "lastUsedAt" = now()
    WHERE "keyHash" = ${hashApiKey(key)} AND "revokedAt" IS NULL
    RETURNING id, "projectId", scope, "createdById", "rateCount",
      (SELECT role FROM team_member m WHERE m."projectId" = api_key."projectId" AND m."userId" = api_key."createdById") AS role`;
  if (!found) {
    return apiError(401, "unauthorized", "This API key isn't valid or was revoked");
  }
  if (!found.role) {
    return apiError(401, "unauthorized", "This API key stopped working when whoever created it left the team");
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
    role: found.role,
  };
}

/**
 * Why the key may not run the operation, or null if it may. Its scope decides reads and writes; its creator's role
 * decides admin and owner operations, as it would for them signed in.
 */
export function refusal(key: ApiKey, operation: Pick<Operation, "scope" | "access">): string | null {
  if (operation.scope === "write" && key.scope === "read") {
    return "This key can only read. Create a read + write key to change things.";
  }
  if (operation.access === "admin" && key.role !== "OWNER" && key.role !== "ADMIN") {
    return "This key's creator is no longer a project owner or admin, so it can't use project settings";
  }
  if (operation.access === "owner" && key.role !== "OWNER") {
    return "Only project owners can change this";
  }
  return null;
}

