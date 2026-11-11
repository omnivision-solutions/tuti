import { prisma } from "@tuti/db";
import { reviewPath } from "@tuti/jobs";
import { notFound, redirect } from "next/navigation";

import { getMembership } from "@/server/membership";

/**
 * A pull request's page before Autopilot reviewed by post and article (links in emails sent then): its activity page
 * now. An email's Edit then (`?select=<update id>`, one of its updates) opens that update's review.
 */
export default async function CodeChangePage(props: PageProps<"/app/[project]/autopilot/[id]">) {
  const [{ project, id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const select = typeof searchParams.select === "string" ? searchParams.select : null;
  if (select && select !== "likely" && !select.includes(",")) {
    const membership = await getMembership(project);
    if (!membership) {
      notFound();
    }
    const action = await prisma.codeChangeAction.findFirst({
      where: { id: select, codeChangeId: id, codeChange: { projectId: membership.project.id } },
      select: { id: true, kind: true, postId: true, articleId: true },
    });
    const path = action && reviewPath(action);
    if (path) {
      redirect(`/app/${project}/autopilot/${path}`);
    }
  }
  const query = new URLSearchParams(Object.entries(searchParams).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])));
  redirect(`/app/${project}/autopilot/activity/${encodeURIComponent(id)}${query.size > 0 ? `?${query}` : ""}`);
}
