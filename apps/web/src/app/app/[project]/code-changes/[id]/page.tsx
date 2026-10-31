import { permanentRedirect } from "next/navigation";

/** A code change's old address: the same change in Autopilot. */
export default async function CodeChangePage(props: PageProps<"/app/[project]/code-changes/[id]">) {
  const { project, id } = await props.params;
  permanentRedirect(`/app/${project}/autopilot/${encodeURIComponent(id)}`);
}
