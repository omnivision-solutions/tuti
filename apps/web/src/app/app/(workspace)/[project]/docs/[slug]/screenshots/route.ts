import { getMembership } from "@/server/membership";
import { articleScreenshotsRunning } from "@/server/operations/screenshots";

/**
 * Whether the article's screenshots are still being taken, and its newest version: the editor asks while a run goes
 * (articles.takeScreenshots). A route, not a server action, as the changelog editor's: one that refreshes the session's
 * cookie re-renders the page. Only the project's team.
 */
export async function GET(_request: Request, context: RouteContext<"/app/[project]/docs/[slug]/screenshots">) {
  const { project: slug, slug: articleSlug } = await context.params;
  const membership = await getMembership(slug);
  if (!membership) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  return Response.json(await articleScreenshotsRunning(membership.project.id, articleSlug), { headers: { "cache-control": "private, no-store" } });
}
