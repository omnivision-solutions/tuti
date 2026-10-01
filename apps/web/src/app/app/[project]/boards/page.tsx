import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { CreateBoardForm, DeleteBoardButton, EditBoardDialog } from "@/components/boards";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";
import { isAdminRole } from "@/lib/roles";
import { getMembership } from "@/server/membership";

export default async function BoardsPage(props: PageProps<"/app/[project]/boards">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const { project, role } = membership;
  const isAdmin = isAdminRole(role);
  const portal = portalUrl(project.slug);

  const boards = await prisma.board.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, description: true, _count: { select: { posts: true } } },
  });

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Boards</h1>
        <p className="text-sm text-muted-foreground">
          Each board is a separate list on your portal, e.g. feature requests, bugs or integrations.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col divide-y">
          {boards.map((board) => (
            <div key={board.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-1 flex-col">
                <a
                  href={`${portal}/b/${board.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-sm font-medium hover:underline"
                >
                  {board.name}
                </a>
                <span className="truncate text-xs text-muted-foreground">
                  /b/{board.slug} · {board._count.posts} {board._count.posts === 1 ? "post" : "posts"}
                  {board.description && ` · ${board.description}`}
                </span>
              </div>
              {isAdmin && (
                <>
                  <EditBoardDialog projectSlug={project.slug} board={board} />
                  {board._count.posts === 0 && boards.length > 1 && (
                    <DeleteBoardButton projectSlug={project.slug} boardId={board.id} name={board.name} />
                  )}
                </>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>New board</CardTitle>
            <CardDescription>Boards can be renamed or moved to a new URL any time; only empty boards can be deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateBoardForm projectSlug={project.slug} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
