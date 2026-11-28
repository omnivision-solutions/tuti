import { cookieCaller, unlessRefused } from "@/server/trpc/server";

/**
 * Whether the entry's screenshots are still being taken, and when it was last saved: the editor asks while a run goes
 * (changelog.takeScreenshots). A route, not a server action: one that refreshes the session's cookie re-renders the page
 * with its answer, which would start the editor's form afresh over text not saved yet. Only the project's team, as the
 * router decides (changelog.screenshotsStatus).
 */
export async function GET(_request: Request, context: RouteContext<"/app/[project]/changelog/[number]/screenshots">) {
  const { project, number } = await context.params;
  const answer = /^\d{1,9}$/.test(number) && (await unlessRefused((await cookieCaller()).changelog.screenshotsStatus({ project, number: Number(number) })));
  if (!answer) {
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  return Response.json(answer, { headers: { "cache-control": "private, no-store" } });
}
