import { notFound, redirect } from "next/navigation";

import { firstBoardPath } from "@/server/portal-home";
import { portalLinks } from "@/server/portal-base";

/** /feedback opens the first board. */
export default async function FeedbackHome(props: PageProps<"/portal/[project]/feedback">) {
  const { project: slug } = await props.params;
  const path = await firstBoardPath(slug);
  if (!path) {
    notFound();
  }
  redirect((await portalLinks())(path));
}
