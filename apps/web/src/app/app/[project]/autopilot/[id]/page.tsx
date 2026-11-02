import { redirect } from "next/navigation";

/** A pull request's page before Autopilot reviewed by post and article (links in emails sent then): its activity page now. */
export default async function CodeChangePage(props: PageProps<"/app/[project]/autopilot/[id]">) {
  const [{ project, id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const query = new URLSearchParams(Object.entries(searchParams).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])));
  redirect(`/app/${project}/autopilot/activity/${encodeURIComponent(id)}${query.size > 0 ? `?${query}` : ""}`);
}
