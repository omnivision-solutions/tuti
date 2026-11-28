import { apiError as error, authenticate, authenticateTeammate, PROJECT_HEADER, sendsSession } from "@/server/api-auth";
import { matchOperation } from "@/server/operations";
import { keyContext, teammateContext, type TrpcContext } from "@/server/trpc/context";
import { callOperation } from "@/server/trpc/server";

/**
 * The REST API: /api/v1/… → an operation (server/operations), called through the router (server/trpc) as the caller,
 * which decides whether they may. Callers send a project API key as `Authorization: Bearer tuti_…`; it decides the
 * project. A teammate signed in to the mobile app sends their session's token the same way and names the project in
 * a header (server/api-auth.ts): the operation then runs as them, as the web app's calls run it. Never a cookie's
 * session. Errors are `{ "error": { "code", "message" } }` with a matching status.
 */
async function handle(request: Request, { params }: RouteContext<"/api/v1/[...path]">) {
  const { path } = await params;
  const route = matchOperation(request.method, `/${path.join("/")}`);
  if (!route) {
    return error(404, "not_found", "No such endpoint");
  }
  const { operation } = route;

  let context: TrpcContext;
  // The project a teammate's request names; a key's is its own.
  let project: string | undefined;
  if (sendsSession(request)) {
    const teammate = await authenticateTeammate(request);
    if (teammate instanceof Response) {
      return teammate;
    }
    project = request.headers.get(PROJECT_HEADER)!.trim();
    context = teammateContext(teammate, project);
  } else {
    const key = await authenticate(request);
    if (key instanceof Response) {
      return key;
    }
    context = keyContext(key);
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
  const called = await callOperation(context, operation, { ...query, ...(body as object), ...route.params, project });
  return called.ok ? Response.json(called.result) : error(called.status, called.code, called.message);
}


export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
