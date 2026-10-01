import { prisma } from "@tuti/db";
import { notFound, redirect } from "next/navigation";

export default async function WorkspacePage(props: PageProps<"/[workspace]">) {
  const { workspace: slug } = await props.params;

  const board = await prisma.board.findFirst({
    where: { workspace: { slug } },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  });
  if (!board) {
    notFound();
  }

  redirect(`/${slug}/${board.slug}`);
}
