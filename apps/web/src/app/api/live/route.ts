import { prisma } from "@tuti/db";

import { inboxStream } from "@/server/live";
import { getMembership } from "@/server/membership";
import { getSession } from "@/server/session";

/**
 * The team's live updates for a project's support inbox (`?project=<slug>`; server/live.ts): the app's
 * inbox and conversation pages, and the sidebar's count. Signed in with the session cookie, for the
 * project's team only; ends once the session does or they're taken off the team.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const [session, membership] = await Promise.all([getSession(), getMembership(slug)]);
  if (!session || !membership) {
    return new Response("Not found", { status: 404 });
  }
  const projectId = membership.project.id;
  const userId = session.user.id;
  const sessionId = session.session.id;
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
