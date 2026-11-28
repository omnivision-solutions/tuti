import { type PostStatus, prisma } from "@tuti/db";
import { seenAs } from "@tuti/jobs";
import { z } from "zod";

import { asking } from "@/lib/format";
import { storedPropertyFormats } from "@/lib/property-formats";

import { voterTotals } from "../post-lists";
import { TEAM_VIEWER } from "../post-visibility";
import { emailedOnMove } from "./code-changes";
import { defineOperation } from "./define";
import { ROADMAP, roadmapColumns } from "./read";

/** How far back Completed goes on the team's roadmap. */
export const COMPLETED_DAYS = 90;

const STATUSES = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "CLOSED"] as const satisfies readonly PostStatus[];

/**
 * The team's roadmap (Feedback → Roadmap): Planned, In progress and what was completed in the last COMPLETED_DAYS, a board
 * at a time (`board`, its slug; none: every board), each card with who's asking, how many each move emails (asked before
 * such a move), and the team's plan for it.
 */
export const getTeamRoadmap = defineOperation({
  name: "roadmap.team",
  title: "Read the team's roadmap",
  summary: "The team's roadmap columns, a board at a time, with each card's voters, plan and how many each move emails.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  input: z.object({ board: z.string().max(200).optional() }),
  output: z.object({
    boards: z.array(z.object({ slug: z.string(), name: z.string() })),
    board: z.string().nullable(),
    completedDays: z.number(),
    columns: z.array(
      z.object({
        status: z.enum(STATUSES),
        posts: z.array(
          z.object({
            id: z.string(),
            number: z.number(),
            title: z.string(),
            status: z.enum(STATUSES),
            votes: z.number(),
            board: z.string(),
            visibility: z.enum(["PUBLIC", "PRIVATE", "TEAM"]),
            asking: z.string().nullable(),
            emails: z.partialRecord(z.enum(STATUSES), z.number()),
            eta: z.string().nullable(),
            owner: z.object({ name: z.string(), image: z.string().nullable() }).nullable(),
            excerpt: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
  run: async ({ projectId }, input) => {
    const [project, boards] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { askingProperty: true, propertyFormats: true } }),
      prisma.board.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } }),
    ]);
    // One of the project's boards, else every board.
    const board = boards.find((b) => b.slug === input.board)?.slug ?? null;
    const columns = await roadmapColumns(projectId, TEAM_VIEWER, { board: board ?? undefined, completedDays: COMPLETED_DAYS });
    const ids = columns.flat().map((post) => post.id);
    const [totals, moves, plans] = await Promise.all([
      voterTotals(projectId, project.askingProperty, ids),
      emailedOnMove(projectId, columns.flat()),
      prisma.post.findMany({ where: { id: { in: ids } }, select: { id: true, eta: true, body: true, owner: { select: { name: true, image: true } } } }),
    ]);
    const plan = new Map(plans.map(({ id, ...rest }) => [id, rest]));
    const formats = storedPropertyFormats(project.propertyFormats);
    return {
      boards,
      board,
      completedDays: COMPLETED_DAYS,
      columns: ROADMAP.map(({ status }, i) => ({
        status,
        posts: columns[i]!.map((post) => ({
          id: post.id,
          number: post.number,
          title: post.title,
          status: post.status,
          votes: post.voteCount,
          board: post.board.name,
          // Who sees it: Team only on a board turned off (seenAs).
          visibility: seenAs(post),
          asking: totals.has(post.id) ? asking(totals.get(post.id)!, project.askingProperty!, formats) : null,
          emails: moves.get(post.id) ?? {},
          // "Dec 2026", in UTC as months are kept.
          eta: plan.get(post.id)?.eta?.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) ?? null,
          owner: plan.get(post.id)?.owner ?? null,
          // Two lines of it on the card: no more than that goes into the page.
          excerpt: plan.get(post.id)?.body.trim().slice(0, 300) || null,
        })),
      })),
    };
  },
});
