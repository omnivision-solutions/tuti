import { codeChangesEnabled } from "@tuti/shared";
import { permanentRedirect, redirect } from "next/navigation";

/**
 * Settings → AI models is gone: each feature's AI model is on its own page, and this page's last rows (Autopilot's) are
 * on Settings → Autopilot. Where the server has AI but can't run Autopilot (that page isn't there), the first of the AI
 * pages instead, not for good: Autopilot's is the one to open once it can.
 */
export default async function Moved(props: PageProps<"/app/[project]/settings/ai-models">) {
  const { project } = await props.params;
  if (!codeChangesEnabled()) {
    redirect(`/app/${project}/settings/ai-answers`);
  }
  permanentRedirect(`/app/${project}/settings/autopilot`);
}
