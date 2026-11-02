import { AutopilotTargetPage } from "@/components/autopilot-target-page";

/** A post's review in Autopilot: its updates from every pull request on it. */
export default async function AutopilotPostPage(props: PageProps<"/app/[project]/autopilot/feedback/[id]">) {
  const [{ project, id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  return <AutopilotTargetPage slug={project} type="feedback" id={id} searchParams={searchParams} />;
}
