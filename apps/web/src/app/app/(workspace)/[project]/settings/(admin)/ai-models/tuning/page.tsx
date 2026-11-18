import { permanentRedirect } from "next/navigation";

/** Advanced tuning moved under Settings → Autopilot with the rest of Settings → AI models: its old address opens the new one. */
export default async function Moved(props: PageProps<"/app/[project]/settings/ai-models/tuning">) {
  const { project } = await props.params;
  permanentRedirect(`/app/${project}/settings/autopilot/tuning`);
}
