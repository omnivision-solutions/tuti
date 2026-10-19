import { log } from "@tuti/shared";

import { apiError as error, authenticate } from "@/server/api-auth";
import { matchOperation, OperationError } from "@/server/operations";

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


export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
