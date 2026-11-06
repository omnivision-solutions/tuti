import { prisma, type PostStatus } from "@tuti/db";
import { boardLimit } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BoardOffButton, DeleteBoardButton, EditBoardDialog, NewBoardDialog } from "@/components/boards";
import { ItemList, ItemRow } from "@/components/item-list";
import { VisibilityBadge } from "@/components/visibility-badge";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ACTIVE_STATUSES } from "@/lib/post-filters";
import { isAdminRole } from "@/lib/roles";
import { portalAddress } from "@/server/custom-domains";
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

  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } });
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
      postVisibility: true,
      off: true,
    },
  });
  // Each board's posts as Feedback lists them (merged duplicates aside), and the open ones as the portal counts them.
  // A board with none can be deleted: its merged duplicates move to their originals' boards.
  const counts = await prisma.post.groupBy({
    by: ["boardId", "status"],
    where: { projectId: project.id, duplicateOfId: null },
    _count: true,
  });
  const count = (boardId: string, statuses?: PostStatus[]) =>
    counts.filter((c) => c.boardId === boardId && (!statuses || statuses.includes(c.status))).reduce((n, c) => n + c._count, 0);

  // A project past its plan's limit (after a downgrade, or an import's boards, brought off) keeps its boards; it just
  // can't add more. One that's off turns on while there's room for one more that's on.
  const limit = boardLimit(plan);
  const on = boards.filter((board) => !board.off).length;
  const full = limit !== null && boards.length >= limit;
  const room = limit === null || on < limit;
  const someOff = boards.some((board) => board.off);

  return (
    <>
      <PageHeader
        back={{ href: `/app/${project.slug}/feedback`, label: "Feedback" }}
        title="Boards"
        actions={isAdmin && !full && <NewBoardDialog projectSlug={project.slug} />}
      />

      {isAdmin && full && (
        <Alert>
          <AlertDescription>
            <p>
              Projects on the {plan === "FREE" ? "free" : "Pro"} plan have up to {limit} feedback boards.{" "}
              <Link href={`/app/${project.slug}/settings/billing`} className="underline underline-offset-4">
                Upgrade to {plan === "FREE" ? "Pro" : "Business"}
              </Link>{" "}
              {someOff && !room ? "to add more, or to turn on the boards that are off." : "to add more."}
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent>
          <ItemList>
            {boards.map((board) => (
              <ItemRow
                wideActions
                key={board.id}
                title={
                  <Link href={`/app/${project.slug}/feedback?board=${board.slug}&status=all`} className="hover:underline">
                    {board.name}
                  </Link>
                }
                badges={
                  board.off ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Off
                    </Badge>
                  ) : (
                    <VisibilityBadge visibility={board.postVisibility} of="board" />
                  )
                }
                meta={
                  <>
                    {/* What Off means, in words everyone sees (not a hover). */}
                    {board.off && "Not on the portal: only the team sees it and its posts · "}
                    <a href={`${portal}/feedback/${board.slug}`} target="_blank" rel="noreferrer" className="hover:underline">
                      /feedback/{board.slug}
                    </a>
                    {" · "}
                    {count(board.id)} {count(board.id) === 1 ? "post" : "posts"}
                    {count(board.id) > 0 && ` · ${count(board.id, ACTIVE_STATUSES)} open`}
                    {board.description && ` · ${board.description}`}
                  </>
                }
                actions={
                  isAdmin && (
                    <>
                      <EditBoardDialog projectSlug={project.slug} board={board} />
                      {(!board.off || room) && <BoardOffButton projectSlug={project.slug} boardId={board.id} name={board.name} off={board.off} stuck={limit !== null && on > limit} />}
                      {count(board.id) === 0 && boards.length > 1 && (
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
