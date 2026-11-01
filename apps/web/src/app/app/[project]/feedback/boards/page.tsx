import { prisma } from "@tuti/db";
import { boardLimit } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeleteBoardButton, EditBoardDialog, NewBoardDialog } from "@/components/boards";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
      _count: { select: { posts: true } },
    },
  });

  // A project past its plan's limit (after a downgrade) keeps its boards; it just can't add more.
  const limit = boardLimit(plan);
  const full = limit !== null && boards.length >= limit;

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
              to add more.
            </p>
          </AlertDescription>
        </Alert>
      )}

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
