import { permanentRedirect } from "next/navigation";

/** Settings → AI models is gone: each feature's AI model is on its own page, and this page's last rows (Autopilot's) are on Settings → Autopilot. */
export default async function Moved(props: PageProps<"/app/[project]/settings/ai-models">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/autopilot`);
}
