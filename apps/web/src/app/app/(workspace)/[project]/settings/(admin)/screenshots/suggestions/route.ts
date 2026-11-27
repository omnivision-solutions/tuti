import { getAdminProject } from "@/server/membership";
import { call } from "@/server/operations/run";
import { suggestScreenshotDomains } from "@/server/operations/screenshots";
import { getSession } from "@/server/session";

/**
 * Settings → Screenshots' suggestions (screenshotSettings.suggestions): the sign-in services the app calls, with the
 * hosts to allow. A route, not a server action: reading an app can take seconds, and server actions run one at a time,
 * so Save and Test would wait behind it. Admins only.
 */
export async function GET(_request: Request, context: RouteContext<"/app/[project]/settings/screenshots/suggestions">) {
  const { project: slug } = await context.params;
  const [session, project] = await Promise.all([getSession(), getAdminProject(slug)]);
  if (!session || !project) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  const { suggestions } = await call(suggestScreenshotDomains, { actor: { kind: "user", userId: session.user.id }, projectId: project.id }, {});
  return Response.json({ suggestions }, { headers: { "cache-control": "private, no-store" } });
}
