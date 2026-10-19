import { exportZip } from "@/server/export";
import { getAdminProject } from "@/server/membership";

/** "Export as Markdown" in settings: the project's content as a ZIP download, for owners and admins. */
export async function GET(_request: Request, { params }: RouteContext<"/app/[project]/settings/export">) {
  const { project: slug } = await params;
  const project = await getAdminProject(slug);
  if (!project) {
    // Like the settings page: team members who aren't owners or admins get the same answer as outsiders.
    return new Response("Not found", { status: 404 });
  }
  const now = new Date();
  return new Response(exportZip(project, now), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${project.slug}-export-${now.toISOString().slice(0, 10)}.zip"`,
      "cache-control": "no-store",
    },
  });
}
