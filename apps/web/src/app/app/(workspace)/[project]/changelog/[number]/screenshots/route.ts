import { getMembership } from "@/server/membership";
import { entryScreenshotsRunning } from "@/server/operations/screenshots";

/**
 * Whether the entry's screenshots are still being taken, and when it was last saved: the editor asks while a run goes
 * (changelog.takeScreenshots). A route, not a server action: one that refreshes the session's cookie re-renders the page
 * with its answer, which would start the editor's form afresh over text not saved yet. Only the project's team.
 */
export async function GET(_request: Request, context: RouteContext<"/app/[project]/changelog/[number]/screenshots">) {
  const { project: slug, number } = await context.params;
  const membership = await getMembership(slug);
  if (!membership || !/^\d{1,9}$/.test(number)) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  return Response.json(await entryScreenshotsRunning(membership.project.id, Number(number)), { headers: { "cache-control": "private, no-store" } });
}
