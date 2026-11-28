import { TRPCError } from "@trpc/server";

import { apiError, authenticateTeammate, PROJECT_HEADER, sendsSession } from "@/server/api-auth";
import { inboxStream } from "@/server/live";
import { getSession } from "@/server/session";
import { sessionContext, stillContext, teammateContext, type TrpcContext } from "@/server/trpc/context";
import { createCaller } from "@/server/trpc/server";

/**
 * The team's live updates for a project's support inbox (server/live.ts): the app's inbox and conversation pages,
 * and the sidebar's count. For the project's team only (`live.inbox`, through the router); ends once the session does or
 * they're taken off the team.
 *
 * Two ways in. The web app's pages: the session cookie and `?project=<slug>`, 404 for anyone else. The mobile app:
 * its session as /api/v1 takes it, `Authorization: Bearer <session token>` and the slug in `Tuti-Project`, refused as
 * /api/v1 refuses (server/auth/app-sign-in.ts has the app's contract). Which one is told by what only the web sends (the
 * query) and only the app sends (the header, which no page's EventSource can), never by Authorization: a self-hoster's
 * proxy may add its own to the web's requests (a password, a sign-in's token). On the app's way the request's cookies
 * aren't read, and nothing it gets back sets one.
 */
export async function GET(request: Request) {
  const web = !request.headers.has(PROJECT_HEADER) && new URL(request.url).searchParams.has("project");
  const caller = web ? await signedIn(request) : await teammate(request);
  if (caller instanceof Response) {
    return caller;
  }
  const { context, slug } = caller;
  const projectId = await allowed(context, slug);
  if (!projectId || !context.who || context.who.kind !== "session") {
    return web ? new Response("Not found", { status: 404 }) : apiError(403, "forbidden", "You're not on the team of a project with that slug");
  }
  const { who } = context;
  return inboxStream(request, {
    wants: (change) => change.projectId === projectId,
    stillAllowed: async () => {
      const still = await stillContext(who);
      return !!still && (await allowed(still, slug)) === projectId;
    },
  });
}

/**
 * The project whose changes the caller may hear (`live.inbox`), or null where the router refuses them. Anything else (the
 * database unreachable) throws: a keepalive's check then keeps the stream open (inboxStream), as before.
 */
async function allowed(context: TrpcContext, slug: string): Promise<string | null> {
  try {
    return (await createCaller(context).live.inbox({ project: slug })).projectId;
  } catch (error) {
    if (error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR") {
      return null;
    }
    throw error;
  }
}

type Caller = { context: TrpcContext; slug: string };

/** The web app's page: its cookie session only, so a proxy's Authorization on the web's requests is never a session here. */
async function signedIn(request: Request): Promise<Caller> {
  return { context: sessionContext(await getSession()), slug: new URL(request.url).searchParams.get("project") ?? "" };
}

/** The mobile app: its session token and the project it names, as /api/v1 takes them until T11. */
async function teammate(request: Request): Promise<Caller | Response> {
  if (!sendsSession(request)) {
    return apiError(401, "unauthorized", "Live updates take a teammate's session from the app: Authorization: Bearer <session token>");
  }
  const found = await authenticateTeammate(request);
  if (found instanceof Response) {
    return found;
  }
  const slug = request.headers.get(PROJECT_HEADER)!.trim();
  return { context: teammateContext(found, slug), slug };
}
