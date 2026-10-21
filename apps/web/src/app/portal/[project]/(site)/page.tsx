import { prisma } from "@tuti/db";
import { notFound, redirect } from "next/navigation";

import { boardPath } from "@/lib/post-urls";

/** The portal's home: what the team picked (Settings → Home page), the first board unless they did. */
export default async function PortalHome(props: PageProps<"/portal/[project]">) {
  const { project: slug } = await props.params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { portalHome: true } });
  if (project && project.portalHome !== "FEEDBACK") {
    redirect(`/${project.portalHome.toLowerCase()}`);
  }

  const board = await prisma.board.findFirst({
    where: { project: { slug } },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  });
  if (!board) {
    notFound();
  }

  redirect(boardPath(board));
}
