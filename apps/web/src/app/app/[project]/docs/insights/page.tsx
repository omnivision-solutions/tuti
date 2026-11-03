import { redirect } from "next/navigation";

/** Docs' Insights moved to Reporting (its gaps to Unanswered questions, its searches to Searches): old links land there. */
export default async function DocsInsightsPage(props: PageProps<"/app/[project]/docs/insights">) {
  const { project } = await props.params;
  redirect(`/app/${project}/reporting`);
}
