import { log } from "@tuti/shared";

import { apiError as error, authenticate, authenticateTeammate, refusal, sendsSession } from "@/server/api-auth";
import { matchOperation, OperationError } from "@/server/operations";

/**
 * The REST API: /api/v1/… → an operation (server/operations). Callers send a
 * project API key as `Authorization: Bearer tuti_…`; it decides the project.
 * A teammate signed in to the mobile app sends their session's token the same
 * way and names the project in a header (server/api-auth.ts): the operation
 * then runs as them, as the web app's actions run it. Never a cookie's session.
 * Errors are `{ "error": { "code", "message" } }` with a matching status.
 */
async function handle(request: Request, { params }: RouteContext<"/api/v1/[...path]">) {
  const { path } = await params;
  const route = matchOperation(request.method, `/${path.join("/")}`);
  if (!route) {
    return error(404, "not_found", "No such endpoint");
  }
  const { operation } = route;

  const caller = sendsSession(request) ? await authenticateTeammate(request) : await authenticate(request);
  if (caller instanceof Response) {
    return caller;
  }
  const refused = refusal(caller, operation);
  if (refused) {
    return error(403, "forbidden", refused);
  }

  let body: unknown = {};
  const text = request.method === "GET" ? "" : await request.text();
  if (text.trim() !== "" || request.method === "POST" || request.method === "PATCH") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
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
    const actor = caller.kind === "user" ? { kind: caller.kind, userId: caller.userId, sessionId: caller.sessionId } : caller;
    return Response.json(await operation.run({ actor, projectId: caller.projectId }, input.data));
  } catch (e) {
    if (e instanceof OperationError) {
      return error(e.status, e.code, e.message);
    }
    log.error("API operation failed", { operation: operation.name, error: e });
    return error(500, "internal_error", "Something went wrong");
  }
}


export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
