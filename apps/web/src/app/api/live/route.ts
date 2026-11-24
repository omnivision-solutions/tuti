import { prisma } from "@tuti/db";

import { apiError, authenticateTeammate, sendsSession } from "@/server/api-auth";
import { inboxStream } from "@/server/live";
import { getMembership } from "@/server/membership";
import { getSession } from "@/server/session";

/**
 * The team's live updates for a project's support inbox (server/live.ts): the app's inbox and conversation pages,
 * and the sidebar's count. For the project's team only; ends once the session does or they're taken off the team.
 *
 * Two ways in. The web app's pages: the session cookie and `?project=<slug>`, 404 for anyone else. The mobile app:
 * its session as /api/v1 takes it, `Authorization: Bearer <session token>` and the slug in `Tuti-Project`, refused as
 * /api/v1 refuses (lib/app-sign-in.ts has the app's contract). A request with an Authorization header is only ever
 * the app's: its cookies aren't read, and nothing it gets back sets one.
 */
export async function GET(request: Request) {
  const viewer = request.headers.has("authorization") ? await teammate(request) : await signedIn(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const { projectId, userId, sessionId } = viewer;
  return inboxStream(request, {
    wants: (change) => change.projectId === projectId,
    stillAllowed: async () => {
      const [stillSignedIn, stillOnTeam] = await Promise.all([
        prisma.session.count({ where: { id: sessionId, expiresAt: { gt: new Date() } } }),
        prisma.teamMember.count({ where: { projectId, userId } }),
      ]);
      return stillSignedIn > 0 && stillOnTeam > 0;
    },
  });
}

type Viewer = { projectId: string; userId: string; sessionId: string };

async function signedIn(request: Request): Promise<Viewer | Response> {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const [session, membership] = await Promise.all([getSession(), getMembership(slug)]);
  if (!session || !membership) {
    return new Response("Not found", { status: 404 });
  }
  return { projectId: membership.project.id, userId: session.user.id, sessionId: session.session.id };
}

async function teammate(request: Request): Promise<Viewer | Response> {
  if (!sendsSession(request)) {
    return apiError(401, "unauthorized", "Live updates take a teammate's session from the app: Authorization: Bearer <session token>");
  }
  return authenticateTeammate(request);
}
