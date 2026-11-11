import { AutopilotTargetPage } from "@/components/autopilot-target-page";

/** An article's review in Autopilot (or a new article's, by its update's id until its draft exists): its updates from every pull request on it. */
export default async function AutopilotArticlePage(props: PageProps<"/app/[project]/autopilot/articles/[id]">) {
  const [{ project, id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  return <AutopilotTargetPage slug={project} type="articles" id={id} searchParams={searchParams} />;
}
