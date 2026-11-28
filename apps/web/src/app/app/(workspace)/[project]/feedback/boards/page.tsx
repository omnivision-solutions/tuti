import type { Metadata } from "next";
import { boardLimit, planDisplay, roomierPlan } from "@tuti/shared";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";

import { BoardMenu, BoardOnButton, EditBoardDialog, NewBoardDialog } from "@/components/boards";
import { VisibilityBadge } from "@/components/visibility-badge";
import { feedbackMenu } from "@/components/feedback-menu";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { InOrderProvider } from "@/components/trpc";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Boards" };

/** Feedback → Boards: the portal's boards, each with its settings; "New board" in a dialog (owners and admins). */
export default async function BoardsPage(props: PageProps<"/app/[project]/feedback/boards">) {
  const { project: slug } = await props.params;
  const caller = await serverCaller();
  // The team's (others get a 404); its settings and translations, owners and admins' (`admin`).
  const [{ admin: isAdmin, portal, boards, plan }, menu] = await Promise.all([caller.boards.page({ project: slug }), feedbackMenu({ project: { slug } })]);
  const project = { slug };

  // A project past its plan's limit (after a downgrade, or an import's boards, brought off) keeps its boards; it just
  // can't add more. One that's off turns on while there's room for one more that's on.
  const limit = boardLimit(plan);
  const roomier = roomierPlan(plan, boardLimit);
  const on = boards.filter((board) => !board.off).length;
  const full = limit !== null && boards.length >= limit;
  const room = limit === null || on < limit;
  const someOff = boards.some((board) => board.off);

  return (
    <PaneLayout>
      {menu}
      <Pane aria-label="Boards">
      <PaneHeader
        title="Boards"
        description="Where people post ideas and problems on your portal."
        actions={isAdmin && !full && <NewBoardDialog projectSlug={project.slug} />}
      />
      <PaneBody className="flex flex-col gap-4 p-3 @min-[48rem]/app:p-5">

      {isAdmin && full && (
        <Alert>
          <AlertDescription>
            <p>
              Projects on the {planDisplay(plan).name} plan have up to {limit} feedback boards.
              {roomier && (
                <>
                  {" "}
                  <Link href={`/app/${project.slug}/settings/billing`} className="underline underline-offset-4">
                    Upgrade to {roomier.name}
                  </Link>{" "}
                  {someOff && !room ? "to add more, or to turn on the boards that are off." : "to add more."}
                </>
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* A card a board: its name and who sees it, its description, its posts, where it is on the portal; then its actions. */}
      {/* One queue for the page's saves (useInOrder): turning a board on and off again land in the order asked. */}
      <InOrderProvider>
      <ul aria-label="Boards" className="grid gap-4 md:grid-cols-2">
        {boards.map((board) => (
          <li key={board.id}>
            {/* The whole card opens its posts (its name's link stretched over it); its buttons sit above that. */}
            <Card className="relative h-full gap-4 transition-shadow hover:shadow-sm">
              <CardContent className="flex flex-1 flex-col gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h2 className="min-w-0 text-[1.0625rem] font-semibold break-words">
                    <Link href={`/app/${project.slug}/feedback?board=${board.slug}&status=all`} className="after:absolute after:inset-0 hover:underline">
                      {board.name}
                    </Link>
                  </h2>
                  {board.off ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Off
                    </Badge>
                  ) : board.postVisibility === "PUBLIC" ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Public
                    </Badge>
                  ) : (
                    <VisibilityBadge visibility={board.postVisibility} of="board" />
                  )}
                </div>
                {/* What Off means, in words everyone sees (not a hover). */}
                {board.off && <p className="text-sm text-muted-foreground">Not on the portal: only the team sees it and its posts.</p>}
                {board.description && <p className="text-sm break-words text-muted-foreground">{board.description}</p>}
                <dl className="flex gap-6">
                  <div className="flex flex-col">
                    <dt className="text-xs text-muted-foreground">Posts</dt>
                    <dd className="text-xl font-semibold tabular-nums">{board.posts}</dd>
                  </div>
                  <div className="flex flex-col">
                    <dt className="text-xs text-muted-foreground">Still open</dt>
                    <dd className="text-xl font-semibold tabular-nums">{board.open}</dd>
                  </div>
                </dl>
                {/* Where it is on one line, its actions on the next (the same on every card, whatever the URL's length). */}
                <div className="relative mt-auto flex flex-col gap-2 border-t pt-3">
                  {/* Where it is on the portal (whether it's on it, its badge says). */}
                  <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                    <a href={`${portal}/feedback/${board.slug}`} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:text-foreground hover:underline">
                      <span className="truncate">/feedback/{board.slug}</span>
                      <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0" />
                    </a>
                  </span>
                  {isAdmin && (
                    <div className="-mb-1 flex items-center gap-1">
                      <EditBoardDialog projectSlug={project.slug} board={board} translations={board.translations ?? undefined} />
                      {board.off && <BoardOnButton projectSlug={project.slug} boardId={board.id} name={board.name} off teamOnly={board.postVisibility === "TEAM"} stuck={limit !== null && on > limit} />}
                      <BoardMenu
                        projectSlug={project.slug}
                        boardId={board.id}
                        name={board.name}
                        off={board.off}
                        teamOnly={board.postVisibility === "TEAM"}
                        stuck={limit !== null && on > limit}
                        deletable={board.posts === 0 && boards.length > 1}
                      />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      </InOrderProvider>
      </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
