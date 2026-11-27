import { getAdminProject } from "@/server/membership";
import { OperationError } from "@/server/operations/define";
import { call } from "@/server/operations/run";
import { getScreenshotSignInDomains } from "@/server/operations/screenshots";
import { getSession } from "@/server/session";

/**
 * Settings → Screenshots' sign-in domains (screenshotSettings.signInDomains): the hosts found for the app's sign-in,
 * allowed for its runs, or `checking` while the worker reads the app. A route, not a server action: the page asks again
 * every few seconds while it's checking, and server actions run one at a time, so Save and Test would wait behind it.
 * `?start=false` (those polls) never starts a read. Admins only.
 */
export async function GET(request: Request, context: RouteContext<"/app/[project]/settings/screenshots/sign-in-domains">) {
  const { project: slug } = await context.params;
  const [session, project] = await Promise.all([getSession(), getAdminProject(slug)]);
  if (!session || !project) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  try {
    const start = new URL(request.url).searchParams.get("start") !== "false";
    const { domains, checking } = await call(getScreenshotSignInDomains, { actor: { kind: "user", userId: session.user.id }, projectId: project.id }, { start });
    return Response.json({ domains, checking }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    // Over the fetch limits (429): said as such, not as a server error; the page shows none until the next look.
    if (error instanceof OperationError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "private, no-store" } });
    }
    throw error;
  }
}
