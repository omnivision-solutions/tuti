import { type PostStatus, prisma } from "@tuti/db";
import { seenAs } from "@tuti/jobs";
import { storedRule } from "@tuti/shared/group-conditions";
import { z } from "zod";

import { asking } from "@/lib/format";
import { type PostFilters, TEAM_SORTS } from "@/lib/post-filters";
import { storedPropertyFormats } from "@/lib/property-formats";

import { teamPostCounts, teamPosts, voterTotals } from "../post-lists";
import { emailedOnMove } from "./code-changes";
import { defineOperation } from "./define";

const STATUSES = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "CLOSED"] as const satisfies readonly PostStatus[];
const person = z.object({ name: z.string(), image: z.string().nullable() });

/**
 * Feedback's list (the team's): a status's posts (none: every status), or the possible duplicates, on a board and voted
 * for by a reader group when they're the project's, matching a search; up to `page` pages. Each row with who's asking and
 * how many each move emails (asked first); the tabs' counts over the same board, group and search; the filters' boards
 * and groups.
 */
export const getFeedbackList = defineOperation({
  name: "feedback.list",
  title: "Read Feedback's list",
  summary: "The team's posts for Feedback's list, a page at a time, with the tabs' counts and the filters' boards and groups.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  input: z.object({
    status: z.enum(STATUSES).optional(),
    duplicates: z.boolean().optional(),
    board: z.string().max(200).optional(),
    group: z.string().max(200).optional(),
    q: z.string().max(255).optional(),
    sort: z.enum(Object.keys(TEAM_SORTS) as [keyof typeof TEAM_SORTS, ...(keyof typeof TEAM_SORTS)[]]).optional(),
    page: z.number().int().min(1).max(1000).optional(),
  }),
  output: z.object({
    projectId: z.string(),
    askingProperty: z.string().nullable(),
    propertyFormats: z.unknown(),
    boards: z.array(z.object({ slug: z.string(), name: z.string() })),
    groups: z.array(z.object({ key: z.string(), name: z.string() })),
    board: z.string().nullable(),
    group: z.string().nullable(),
    posts: z.array(
      z.object({
        id: z.string(),
        number: z.number(),
        title: z.string(),
        status: z.enum(STATUSES),
        voteCount: z.number(),
        commentCount: z.number(),
        sample: z.boolean(),
        authorId: z.string(),
        visibility: z.enum(["PUBLIC", "PRIVATE", "TEAM"]),
        board: z.string(),
        possibleDuplicate: z.boolean(),
        excerpt: z.string().nullable(),
        author: person,
        owner: person.nullable(),
        createdAt: z.iso.datetime(),
        asking: z.string().nullable(),
        emails: z.partialRecord(z.enum(STATUSES), z.number()),
      }),
    ),
    more: z.boolean(),
    counts: z.object({ all: z.number(), duplicates: z.number(), statuses: z.record(z.enum(STATUSES), z.number()) }),
  }),
  run: async ({ projectId }, input) => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        askingProperty: true,
        propertyFormats: true,
        boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } },
        readerGroups: { orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true, conditions: true, match: true } },
      },
    });
    // One of the project's boards and groups, else all of them.
    const board = project.boards.find((b) => b.slug === input.board)?.slug;
    const group = project.readerGroups.find((g) => g.key === input.group);
    const scope = { board, q: input.q?.trim() || undefined, group: group && storedRule(group) };
    const filters: PostFilters = { statusParam: "all", status: input.status, sort: input.sort ?? "top", board, page: input.page ?? 1 };
    const [{ posts, more }, counts] = await Promise.all([teamPosts(projectId, filters, { ...scope, duplicatesOnly: input.duplicates }), teamPostCounts(projectId, scope)]);
    // Who's asking, and how many moving each one to each status emails (asked first, from its row or picked with others:
    // none for a move that emails nobody, to Completed when it's completed already, say).
    const [totals, moves] = await Promise.all([voterTotals(projectId, project.askingProperty, posts.map((post) => post.id)), emailedOnMove(projectId, posts)]);
    const formats = storedPropertyFormats(project.propertyFormats);
    return {
      projectId,
      askingProperty: project.askingProperty,
      propertyFormats: project.propertyFormats,
      boards: project.boards,
      groups: project.readerGroups.map(({ key, name }) => ({ key, name })),
      board: board ?? null,
      group: group?.key ?? null,
      posts: posts.map((post) => ({
        id: post.id,
        number: post.number,
        title: post.title,
        status: post.status,
        voteCount: post.voteCount,
        commentCount: post.commentCount,
        sample: post.sample,
        authorId: post.authorId,
        // Who sees it: Team only on a board turned off.
        visibility: seenAs(post),
        board: post.board.name,
        possibleDuplicate: post._count.duplicateSuggestions > 0,
        // A line of it is shown: no more than that goes into the page.
        excerpt: post.body.trim().slice(0, 200) || null,
        author: post.author,
        owner: post.owner,
        createdAt: post.createdAt.toISOString(),
        asking: totals.has(post.id) ? asking(totals.get(post.id)!, project.askingProperty!, formats) : null,
        emails: moves.get(post.id) ?? {},
      })),
      more,
      counts: { all: counts.all, duplicates: counts.duplicates, statuses: Object.fromEntries(STATUSES.map((status) => [status, counts.of(status)])) as Record<PostStatus, number> },
    };
  },
});
