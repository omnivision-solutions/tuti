import type { Metadata } from "next";

import { ListFilters } from "@/components/list-filters";
import { feedbackMenu } from "@/components/feedback-menu";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { RoadmapBoard } from "@/components/roadmap-board";
import { InOrderProvider } from "@/components/trpc";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Roadmap" };

/** The team's roadmap: Planned, In progress and what was completed lately, cards dragged between them; a board at a time. */
export default async function TeamRoadmapPage(props: PageProps<"/app/[project]/feedback/roadmap">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  // A board's slug, else all of them (one too long for any board too: the address may say anything).
  const asked = typeof searchParams.board === "string" && searchParams.board.length <= 200 ? searchParams.board : undefined;
  // The team's (others get a 404), with Feedback's menu alongside.
  const [{ boards, board, completedDays, columns }, menu] = await Promise.all([
    (await serverCaller()).roadmap.team({ project: slug, board: asked }),
    feedbackMenu({ project: { slug } }),
  ]);

  return (
    // One queue for the page's moves (useInOrder): a card dragged, then moved again from its menu, lands in that order.
    <InOrderProvider>
    <PaneLayout>
      {menu}
      <Pane aria-label="Roadmap">
      <PaneHeader
        title="Roadmap"
        description="What's planned, in progress and done. Drag a card to change its status."
        // The board picked at the right.
        actions={
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
        }
      />
      <PaneBody className="flex flex-col gap-4 p-2 @min-[48rem]/app:p-3">
      <RoadmapBoard projectSlug={slug} completedDays={completedDays} columns={columns} />
      </PaneBody>
      </Pane>
    </PaneLayout>
    </InOrderProvider>
  );
}
