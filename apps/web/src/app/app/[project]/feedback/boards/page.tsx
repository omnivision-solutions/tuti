import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { DeleteBoardButton, EditBoardDialog, NewBoardDialog } from "@/components/boards";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { portalAddress } from "@/server/custom-domains";
import { isAdminRole } from "@/lib/roles";
import { getMembership } from "@/server/membership";

/** Feedback → Boards: the portal's boards, each with its settings; "New board" in a dialog (owners and admins). */
export default async function BoardsPage(props: PageProps<"/app/[project]/feedback/boards">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const { project, role } = membership;
  const isAdmin = isAdminRole(role);
  const portal = await portalAddress(project.slug);

  const boards = await prisma.board.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      postButton: true,
      titlePlaceholder: true,
      detailsPlaceholder: true,
      _count: { select: { posts: true } },
    },
  });

  return (
    <>
      <PageHeader
        back={{ href: `/app/${project.slug}/feedback`, label: "Feedback" }}
        title="Boards"
        actions={isAdmin && <NewBoardDialog projectSlug={project.slug} />}
      />

      <Card>
        <CardContent>
          <ItemList>
            {boards.map((board) => (
              <ItemRow
                key={board.id}
                title={
                  <a href={`${portal}/feedback/${board.slug}`} target="_blank" rel="noreferrer" className="hover:underline">
                    {board.name}
                  </a>
                }
                meta={
                  <>
                    /feedback/{board.slug} · {board._count.posts} {board._count.posts === 1 ? "post" : "posts"}
                    {board.description && ` · ${board.description}`}
                  </>
                }
                actions={
                  isAdmin && (
                    <>
                      <EditBoardDialog projectSlug={project.slug} board={board} />
                      {board._count.posts === 0 && boards.length > 1 && (
                        <DeleteBoardButton projectSlug={project.slug} boardId={board.id} name={board.name} />
                      )}
                    </>
                  )
                }
              />
            ))}
          </ItemList>
        </CardContent>
      </Card>

    </>
  );
}
