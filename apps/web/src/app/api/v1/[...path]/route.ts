import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";

import { API_RATE_LIMIT, hashApiKey } from "@/lib/api-keys";
import { type ApiKeyActor, matchOperation, OperationError } from "@/server/operations";

/**
 * The REST API: /api/v1/… → an operation (server/operations). Callers send a
 * project API key as `Authorization: Bearer tuti_…`; it decides the project.
 * Errors are `{ "error": { "code", "message" } }` with a matching status.
 */
async function handle(request: Request, { params }: RouteContext<"/api/v1/[...path]">) {
  const { path } = await params;
  const route = matchOperation(request.method, `/${path.join("/")}`);
  if (!route) {
    return error(404, "not_found", "No such endpoint");
  }
  const { operation } = route;

  const actor = await authenticate(request);
  if (actor instanceof Response) {
    return actor;
  }
  if (operation.scope === "write" && actor.scope === "read") {
    return error(403, "forbidden", "This key can only read. Create a read + write key to change things.");
  }

  let body: unknown = {};
  if (request.method !== "GET") {
    body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return error(400, "invalid_json", "Send a JSON object");
    }
  }
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const input = operation.input.safeParse({ ...query, ...(body as object), ...route.params });
  if (!input.success) {
    const issue = input.error.issues[0];
    return error(400, "invalid_input", issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input");
  }

  try {
    return Response.json(await operation.run({ actor, projectId: actor.projectId }, input.data));
  } catch (e) {
    if (e instanceof OperationError) {
      return error(e.status, e.code, e.message);
    }
    log.error("API operation failed", { operation: operation.name, error: e });
    return error(500, "internal_error", "Something went wrong");
  }
}

/** The key's actor, or the error response. Counts the request against the key's rate limit. */
async function authenticate(request: Request): Promise<ApiKeyActor | Response> {
  const key = /^Bearer (tuti_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!key) {
    return error(401, "unauthorized", "Send a project API key: Authorization: Bearer tuti_…");
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
    return error(401, "unauthorized", "This API key isn't valid or was revoked");
  }
  if (found.rateCount > API_RATE_LIMIT) {
    const retryAfter = Math.ceil((window.getTime() + 60_000 - Date.now()) / 1000);
    return error(429, "rate_limited", `Up to ${API_RATE_LIMIT} requests a minute per key`, {
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

function error(status: number, code: string, message: string, headers?: Record<string, string>) {
  return Response.json({ error: { code, message } }, { status, headers });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
