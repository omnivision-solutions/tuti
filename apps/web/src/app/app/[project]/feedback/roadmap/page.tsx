import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { RoadmapBoard } from "@/components/roadmap-board";
import { asking } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { ROADMAP, roadmapColumns } from "@/server/operations/read";
import { voterTotals } from "@/server/post-lists";

/** How far back Completed goes on the team's roadmap. */
const COMPLETED_DAYS = 90;

/** The team's roadmap: Planned, In progress and what was completed lately, cards dragged between them; a board at a time. */
export default async function TeamRoadmapPage(props: PageProps<"/app/[project]/feedback/roadmap">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const { project } = membership;
  const boards = await prisma.board.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } });
  const board = boards.find((b) => b.slug === searchParams.board)?.slug;
  const columns = await roadmapColumns(project.id, { board, completedDays: COMPLETED_DAYS });
  const ids = columns.flat().map((post) => post.id);
  // Who's asking, and how many completing each one emails (asked before a card goes to Completed).
  const [totals, emails] = await Promise.all([voterTotals(project.id, project.askingProperty, ids), emailedOnCompletion(project.id, ids)]);

  return (
    <>
      <PageHeader title="Roadmap" back={{ href: `/app/${slug}/feedback`, label: "Feedback" }} />
      <ListFilters
        filters={[
          {
            name: "board",
            label: "Board",
            value: board ?? "all",
            options: [{ value: "all", label: "All boards" }, ...boards.map((b) => ({ value: b.slug, label: b.name }))],
          },
        ]}
      />
      <RoadmapBoard
        projectSlug={slug}
        completedDays={COMPLETED_DAYS}
        columns={ROADMAP.map(({ status }, i) => ({
          status,
          posts: columns[i]!.map((post) => ({
            id: post.id,
            number: post.number,
            title: post.title,
            status: post.status,
            votes: post.voteCount,
            board: post.board.name,
            asking: totals.has(post.id) ? asking(totals.get(post.id)!, project.askingProperty!) : null,
            emails: emails.get(post.id) ?? 0,
          })),
        }))}
      />
    </>
  );
}
