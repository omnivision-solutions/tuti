import { prisma } from "@tuti/db";
import { boardLimit } from "@tuti/shared";
import { CopyIcon, InboxIcon, LayoutListIcon, MapIcon, Settings2Icon, SparklesIcon } from "lucide-react";

import { NewBoardDialog } from "@/components/boards";
import { SectionGroup, SectionLink, SectionPane } from "@/components/pane";
import { STATUS_LABELS, StatusIcon } from "@/components/post-status-badge";
import { isAdminRole } from "@/lib/roles";
import { teamPostCounts } from "@/server/post-lists";

/** The statuses the menu lists, as the list's tabs take them (Needs triage is a view of its own, above). */
const STATUSES = [
  ["under-review", "UNDER_REVIEW"],
  ["planned", "PLANNED"],
  ["in-progress", "IN_PROGRESS"],
  ["completed", "COMPLETED"],
] as const;

/**
 * Feedback's section pane, beside its list, the Roadmap, Boards and a post: its views, its boards (each one's posts;
 * a + for a new one, owners and admins with room on their plan), its statuses and Possible duplicates, with counts
 * across every board. On the list, `view` (its tab: "all", "open", a status's, "duplicates") and `board` say which
 * link is open, as the list reads its address; elsewhere the address does.
 * Not a component: a page awaits it in a `Promise.all` with its own queries (one failing, the rest handled) and puts
 * what it gives in what it returns, so the page renders whole, with nothing left to suspend (as tests render it).
 */
export async function feedbackMenu({
  project,
  role,
  view,
  board,
  counts: given,
  className,
}: {
  project: { id: string; slug: string; plan: Parameters<typeof boardLimit>[0] };
  role: Parameters<typeof isAdminRole>[0];
  view?: string;
  board?: string;
  /** The list's own counts, when they're across every board (none filtered): not asked for again. */
  counts?: Awaited<ReturnType<typeof teamPostCounts>>;
  className?: string;
}) {
  // On the list: a board's own link for its All, else the tab's link (a board's other tabs mark the status).
  const open = (link: string) => (view === undefined ? undefined : board && view === "all" ? link === `board:${board}` : link === view);
  const base = `/app/${project.slug}/feedback`;
  const [boards, perBoard, counts] = await Promise.all([
    prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, slug: true, name: true } }),
    // As Feedback lists them: merged duplicates aside.
    prisma.post.groupBy({ by: ["boardId"], where: { projectId: project.id, duplicateOfId: null }, _count: true }),
    given ?? teamPostCounts(project.id, {}),
  ]);
  const limit = boardLimit(project.plan);
  const canAdd = isAdminRole(role) && (limit === null || boards.length < limit);
  return (
    <SectionPane title="Feedback" className={className}>
      <SectionGroup>
        <SectionLink href={`${base}?status=all`} icon={<InboxIcon />} count={counts.all} active={open("all")}>
          All posts
        </SectionLink>
        <SectionLink href={base} icon={<SparklesIcon />} count={counts.of("OPEN")} active={open("open")}>
          Needs triage
        </SectionLink>
        <SectionLink href={`${base}/roadmap`} icon={<MapIcon />} active={view === undefined ? undefined : false}>
          Roadmap
        </SectionLink>
      </SectionGroup>
      <SectionGroup label="Boards" action={canAdd && <NewBoardDialog projectSlug={project.slug} icon />}>
        {boards.map((board) => (
          <SectionLink key={board.id} href={`${base}?board=${board.slug}&status=all`} icon={<LayoutListIcon />} count={perBoard.find((row) => row.boardId === board.id)?._count ?? 0} active={open(`board:${board.slug}`)}>
            {board.name}
          </SectionLink>
        ))}
        <SectionLink href={`${base}/boards`} icon={<Settings2Icon />} active={view === undefined ? undefined : false}>
          Manage boards
        </SectionLink>
      </SectionGroup>
      <SectionGroup label="Statuses">
        {STATUSES.map(([param, status]) => (
          <SectionLink key={status} href={`${base}?status=${param}`} icon={<StatusIcon status={status} />} count={counts.of(status)} active={open(param)}>
            {STATUS_LABELS[status]}
          </SectionLink>
        ))}
      </SectionGroup>
      {/* While there are some, or it's open (as the list's pills). */}
      {(counts.duplicates > 0 || view === "duplicates") && (
        <SectionGroup label="Smart views">
          <SectionLink href={`${base}?show=duplicates`} icon={<CopyIcon />} count={counts.duplicates} active={open("duplicates")}>
            Possible duplicates
          </SectionLink>
        </SectionGroup>
      )}
    </SectionPane>
  );
}
