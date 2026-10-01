import { notFound } from "next/navigation";

import { getMembership } from "@/server/membership";

/** Project pages are for the project's team only (the shell comes from /app). */
export default async function ProjectLayout({ children, params }: LayoutProps<"/app/[project]">) {
  const { project } = await params;
  if (!(await getMembership(project))) {
    notFound();
  }
  return children;
}
