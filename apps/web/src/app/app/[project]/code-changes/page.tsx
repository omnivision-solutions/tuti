import { permanentRedirect } from "next/navigation";

/** Code changes is Autopilot now: its old address lands there. */
export default async function CodeChangesPage(props: PageProps<"/app/[project]/code-changes">) {
  permanentRedirect(`/app/${(await props.params).project}/autopilot`);
}
