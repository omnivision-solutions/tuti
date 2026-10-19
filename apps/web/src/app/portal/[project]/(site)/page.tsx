import { prisma } from "@tuti/db";
import { notFound, redirect } from "next/navigation";

export default async function PortalHome(props: PageProps<"/portal/[project]">) {
  const { project: slug } = await props.params;

  const board = await prisma.board.findFirst({
    where: { project: { slug } },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  });
  if (!board) {
    notFound();
  }

  redirect(`/b/${board.slug}`);
}
