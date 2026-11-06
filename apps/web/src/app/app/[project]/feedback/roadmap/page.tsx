import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { RoadmapBoard } from "@/components/roadmap-board";
import { asking } from "@/lib/format";
import { storedPropertyFormats } from "@/lib/property-formats";
import { getMembership } from "@/server/membership";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { ROADMAP, roadmapColumns } from "@/server/operations/read";
import { TEAM_VIEWER } from "@/server/post-visibility";
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
  const columns = await roadmapColumns(project.id, TEAM_VIEWER, { board, completedDays: COMPLETED_DAYS });
  const ids = columns.flat().map((post) => post.id);
  // Who's asking, how many completing each one emails (asked before a card goes to Completed), and the team's plan for it.
  const [totals, emails, plans] = await Promise.all([
    voterTotals(project.id, project.askingProperty, ids),
    emailedOnCompletion(project.id, ids),
    prisma.post.findMany({ where: { id: { in: ids } }, select: { id: true, eta: true, owner: { select: { name: true, image: true } } } }),
  ]);
  const plan = new Map(plans.map(({ id, ...rest }) => [id, rest]));

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
            asking: totals.has(post.id) ? asking(totals.get(post.id)!, project.askingProperty!, storedPropertyFormats(project.propertyFormats)) : null,
            emails: emails.get(post.id) ?? 0,
            // "Dec 2026", in UTC as months are kept.
            eta: plan.get(post.id)?.eta?.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) ?? null,
            owner: plan.get(post.id)?.owner ?? null,
          })),
        }))}
      />
    </>
  );
}
