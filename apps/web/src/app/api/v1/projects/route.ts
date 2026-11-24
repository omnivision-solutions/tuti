import { apiError, authenticateSession, sendsSession } from "@/server/api-auth";
import { listMyProjects } from "@/server/membership";

/**
 * GET /api/v1/projects: the projects a signed-in teammate is on, with their role in each, for an app to offer after
 * signing in (the web app's project switcher reads the same list). A session's request names one of them in the
 * Tuti-Project header from then on (server/api-auth.ts). Not an operation: those act in one project, and a key has one.
 */
export async function GET(request: Request) {
  if (!sendsSession(request)) {
    return apiError(401, "unauthorized", "This lists a signed-in teammate's projects: send their session's token. A project API key has one project: GET /api/v1/project");
  }
  const session = await authenticateSession(request);
  if (session instanceof Response) {
    return session;
  }
  const projects = await listMyProjects(session.userId);
  return Response.json({ projects: projects.map(({ slug, name, role, openConversations }) => ({ slug, name, role, openConversations })) });
}
