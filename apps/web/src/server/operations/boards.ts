import { type PostStatus, Prisma, prisma } from "@tuti/db";
import { queueLabels } from "@tuti/jobs";
import { aiEnabled, boardLimit, effectivePlan, isLanguage, LANGUAGES, planDisplay, type PlanKey, upgradeFor } from "@tuti/shared";
import { z } from "zod";

import { BOARD_TEXT_LIMITS } from "@/lib/board-texts";
import { ACTIVE_STATUSES } from "@/lib/post-filters";
import { SLUG_PATTERN } from "@/lib/project-slugs";
import { portalAddress } from "@/server/custom-domains";

import { teamPostCounts } from "../post-lists";
import { actingUserId, type Context, defineOperation, OperationError } from "./define";
import { boardTranslationsOf, translationLanguages } from "./label-translations";

/** Feedback → Boards and Feedback's menu: what they read, and a board's settings (owners and admins). */

const name = z.string().trim().min(2, "Name is too short").max(60);
const description = z.string().trim().max(280);
const slug = z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Use lowercase letters, numbers and single dashes").min(2).max(40);
// Empty: the default words (lib/board-texts.ts).
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it to ${max} characters`)
    .transform((value) => value || null);
// Who sees new posts on it (server/post-visibility.ts).
const postVisibility = z.enum(["PUBLIC", "PRIVATE", "TEAM"]);
const boardId = z.string().min(1).max(200);

const duplicateSlug = () => new OperationError(409, "conflict", "This project already has a board with that URL");
const notFound = () => new OperationError(404, "not_found", "Board not found");
const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const boardsFull = (plan: PlanKey, limit: number) =>
  [`Projects on the ${planDisplay(plan).name} plan have up to ${limit} feedback boards.`, upgradeFor(plan, boardLimit, " in Settings → Billing to add more.")].filter(Boolean).join(" ");

/** The caller's role in the project (a key's creator's): what the team's pages show owners and admins alone. */
async function isAdmin({ actor, projectId }: Context) {
  const member = await prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId: actingUserId(actor) } }, select: { role: true } });
  return member?.role === "OWNER" || member?.role === "ADMIN";
}

const STATUSES = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "COMPLETED", "CLOSED"] as const satisfies readonly PostStatus[];

/**
 * Feedback's section pane (components/feedback-menu.tsx), beside its list, the Roadmap, Boards and a post: each board with
 * its posts as Feedback lists them (merged duplicates aside), whether the caller may add one, and the counts across every
 * board, unless the page has them already (`counts: false`).
 */
export const getFeedbackMenu = defineOperation({
  name: "feedback.menu",
  title: "Read Feedback's menu",
  summary: "The boards with their posts, whether the caller may add a board, and the posts in each status.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  input: z.object({ counts: z.boolean().optional() }),
  output: z.object({
    boards: z.array(z.object({ slug: z.string(), name: z.string(), posts: z.number() })),
    canAdd: z.boolean(),
    counts: z.object({ all: z.number(), duplicates: z.number(), statuses: z.record(z.enum(STATUSES), z.number()) }).nullable(),
  }),
  run: async (context, input) => {
    const { projectId } = context;
    const [boards, perBoard, counts, project, admin] = await Promise.all([
      prisma.board.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true, slug: true, name: true } }),
      prisma.post.groupBy({ by: ["boardId"], where: { projectId, duplicateOfId: null }, _count: true }),
      input.counts === false ? null : teamPostCounts(projectId, {}),
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } }),
      isAdmin(context),
    ]);
    const limit = boardLimit(project.plan);
    return {
      boards: boards.map((board) => ({ slug: board.slug, name: board.name, posts: perBoard.find((row) => row.boardId === board.id)?._count ?? 0 })),
      canAdd: admin && (limit === null || boards.length < limit),
      counts: counts && { all: counts.all, duplicates: counts.duplicates, statuses: Object.fromEntries(STATUSES.map((status) => [status, counts.of(status)])) as Record<PostStatus, number> },
    };
  },
});

/**
 * Feedback → Boards: each board with its settings, its posts as Feedback lists them (merged duplicates aside) and the open
 * ones; for owners and admins (`admin`), each one's names in the project's other languages (none: no Translations).
 */
export const getBoardsPage = defineOperation({
  name: "boards.page",
  title: "Read Feedback → Boards",
  summary: "The project's boards with their settings and posts, its plan, and each board's translations for owners and admins.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z.object({
    // Null: the default plan's.
    plan: z.string().nullable(),
    admin: z.boolean(),
    portal: z.string(),
    boards: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        description: z.string().nullable(),
        postButton: z.string().nullable(),
        titlePlaceholder: z.string().nullable(),
        detailsPlaceholder: z.string().nullable(),
        postVisibility,
        off: z.boolean(),
        posts: z.number(),
        open: z.number(),
        translations: z
          .object({
            rows: z.array(z.object({ language: z.string(), native: z.string(), name: z.string().nullable(), description: z.string().nullable().optional(), keepUpToDate: z.boolean() })),
            defaultName: z.string(),
            ai: z.boolean(),
          })
          .nullable(),
      }),
    ),
  }),
  run: async (context) => {
    const { projectId } = context;
    const [project, boards, counts, admin] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true, plan: true, language: true } }),
      prisma.board.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, slug: true, description: true, postButton: true, titlePlaceholder: true, detailsPlaceholder: true, postVisibility: true, off: true, translations: true },
      }),
      prisma.post.groupBy({ by: ["boardId", "status"], where: { projectId, duplicateOfId: null }, _count: true }),
      isAdmin(context),
    ]);
    const count = (id: string, statuses?: PostStatus[]) => counts.filter((c) => c.boardId === id && (!statuses || statuses.includes(c.status))).reduce((n, c) => n + c._count, 0);
    const [languages, portal] = await Promise.all([admin ? translationLanguages(projectId) : [], portalAddress(project.slug)]);
    const defaultName = isLanguage(project.language) ? LANGUAGES[project.language].name : project.language;
    return {
      plan: project.plan,
      admin,
      portal,
      boards: boards.map(({ translations, ...board }) => ({
        ...board,
        posts: count(board.id),
        open: count(board.id, ACTIVE_STATUSES),
        // A board readers don't see (off, or the team's alone) isn't translated, as a sample collection isn't: no Keep up to date.
        translations:
          languages.length > 0
            ? {
                rows: boardTranslationsOf({ ...board, translations }, languages).flatMap((row) => (isLanguage(row.language) ? [{ ...row, native: LANGUAGES[row.language].native }] : [])),
                defaultName,
                ai: aiEnabled() && !board.off && board.postVisibility !== "TEAM",
              }
            : null,
      })),
    };
  },
});

/** The project's row locked (createBoard's, setBoardOff's and deleteBoard's), with its plan as it is now. */
async function lockedPlan(tx: Prisma.TransactionClient, projectId: string, lock: "FOR UPDATE" | "FOR NO KEY UPDATE") {
  const [row] =
    lock === "FOR UPDATE"
      ? await tx.$queryRaw<{ plan: PlanKey; trialEndsAt: Date | null }[]>`SELECT "planKey" AS plan, "trialEndsAt" FROM project WHERE id = ${projectId} FOR UPDATE`
      : await tx.$queryRaw<{ plan: PlanKey; trialEndsAt: Date | null }[]>`SELECT "planKey" AS plan, "trialEndsAt" FROM project WHERE id = ${projectId} FOR NO KEY UPDATE`;
  // Its plan (null: the default plan's limits), or none when there's no such project.
  return row && { plan: effectivePlan(row.plan, row.trialEndsAt) };
}

export const createBoard = defineOperation({
  name: "boards.create",
  title: "Create a board",
  summary: "Add a feedback board to the portal, while the plan has room for one more.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "admin",
  input: z.object({ name, slug, description: description.optional(), postVisibility: postVisibility.optional() }),
  output: z.object({}),
  run: async ({ projectId }, input) => {
    try {
      await prisma.$transaction(async (tx) => {
        // Room on the plan, counted under the project's lock so two boards made at once can't both take the last place. A
        // project already past its limit (after a downgrade, or an import's boards turned off) keeps its boards; it can't add
        // more. Boards turned off count too, so turning one off never makes room for another.
        const locked = await lockedPlan(tx, projectId, "FOR UPDATE");
        const limit = locked ? boardLimit(locked.plan) : null;
        if (locked && limit !== null && (await tx.board.count({ where: { projectId } })) >= limit) {
          throw new OperationError(409, "no_room", boardsFull(locked.plan, limit));
        }
        // Taking a slug that used to redirect to another board ends that redirect.
        await tx.boardRedirect.deleteMany({ where: { projectId, slug: input.slug } });
        await tx.board.create({ data: { projectId, name: input.name, slug: input.slug, description: input.description || null, postVisibility: input.postVisibility } });
      });
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateSlug() : error;
    }
    // Its name and description in the project's other languages (docs/plan.md L14), in the background.
    await queueLabels(projectId);
    return {};
  },
});

/** Changing a board's URL keeps the old one working as a redirect. */
export const updateBoard = defineOperation({
  name: "boards.update",
  title: "Update a board",
  summary: "Change a feedback board's name, URL, description, words for posting and who sees its new posts; fields left out stay as they are.",
  method: "PATCH",
  internal: true,
  scope: "write",
  access: "admin",
  input: z.object({
    board: boardId,
    name,
    slug,
    description: description.optional(),
    postButton: text(BOARD_TEXT_LIMITS.postButton).optional(),
    titlePlaceholder: text(BOARD_TEXT_LIMITS.titlePlaceholder).optional(),
    detailsPlaceholder: text(BOARD_TEXT_LIMITS.detailsPlaceholder).optional(),
    postVisibility: postVisibility.optional(),
  }),
  output: z.object({}),
  run: async ({ projectId }, { board: id, slug, description, ...fields }) => {
    const board = await prisma.board.findFirst({ where: { id, projectId }, select: { slug: true } });
    if (!board) {
      throw notFound();
    }
    try {
      await prisma.$transaction(async (tx) => {
        if (slug !== board.slug) {
          await tx.boardRedirect.deleteMany({ where: { projectId, slug } });
          await tx.boardRedirect.upsert({
            where: { projectId_slug: { projectId, slug: board.slug } },
            create: { projectId, boardId: id, slug: board.slug },
            update: { boardId: id },
          });
        }
        await tx.board.update({ where: { id }, data: { ...fields, slug, ...(description !== undefined && { description: description || null }) } });
      });
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateSlug() : error;
    }
    // A new name, description or visibility (a board the team alone had now shown): translated again, in the background.
    await queueLabels(projectId);
    return {};
  },
});

/**
 * Turns a board off (Board.off: the team's alone, its posts off the portal) or on again, while the plan has room for
 * one more that's on: a project past its limit (an import's boards, brought off) turns them on after an upgrade.
 */
export const setBoardOff = defineOperation({
  name: "boards.setOff",
  title: "Turn a board off or on",
  summary: "Take a feedback board off the portal (only the team sees it and its posts), or put it back while the plan has room.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "admin",
  input: z.object({ board: boardId, off: z.boolean() }),
  output: z.object({}),
  run: async ({ projectId }, { board: id, off }) => {
    await prisma.$transaction(async (tx) => {
      // The project's row locked as deleteBoard's (createBoard's lock waits on it too), so two can't both take the last place.
      const locked = await lockedPlan(tx, projectId, "FOR NO KEY UPDATE");
      const board = await tx.board.findFirst({ where: { id, projectId }, select: { off: true } });
      if (!locked || !board) {
        throw notFound();
      }
      const { plan } = locked;
      const limit = boardLimit(plan);
      if (board.off && !off && limit !== null && (await tx.board.count({ where: { projectId, off: false } })) >= limit) {
        throw new OperationError(409, "no_room", boardsFull(plan, limit).replace("to add more", "to turn it on"));
      }
      await tx.board.update({ where: { id }, data: { off } });
      if (off) {
        // Emails still due about its posts (a delayed job's, a retry's) go to nobody now, nor once it's turned on again.
        await tx.post.updateMany({ where: { boardId: id, shippedEmailsDueAt: { not: null } }, data: { shippedEmailsDueAt: null } });
        await tx.comment.updateMany({ where: { post: { boardId: id }, votersEmailDueAt: { not: null } }, data: { votersEmailDueAt: null } });
        await tx.comment.updateMany({ where: { post: { boardId: id }, authorEmailDueAt: { not: null } }, data: { authorEmailDueAt: null } });
      }
    });
    // Turned on: translated, if it wasn't yet (in the background).
    if (!off) await queueLabels(projectId);
    return {};
  },
});

/**
 * Only empty boards can be deleted, and a project always keeps at least one. Merged duplicates don't count (they're in
 * no list, and Move to board can't reach them): they move to the boards of the posts they were merged into.
 */
export const deleteBoard = defineOperation({
  name: "boards.delete",
  title: "Delete a board",
  summary: "Delete an empty feedback board; a project keeps at least one.",
  method: "DELETE",
  internal: true,
  scope: "write",
  access: "admin",
  input: z.object({ board: boardId }),
  output: z.object({}),
  run: async ({ projectId }, { board: id }) => {
    const board = await prisma.board.findFirst({ where: { id, projectId }, select: { id: true } });
    if (!board) {
      throw notFound();
    }
    await prisma.$transaction(async (tx) => {
      // The project's row locked (createBoard's lock waits on it too), so two deletes can't both leave it without a board. Not
      // FOR UPDATE: that would block the key-share lock a post insert takes on it while holding the board's, a deadlock.
      await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${projectId} FOR NO KEY UPDATE`;
      if ((await tx.board.count({ where: { projectId } })) <= 1) {
        throw new OperationError(409, "conflict", "A project needs at least one board");
      }
      // The board's row locked holds off posts moved or added to it; its posts' rows, merges and unmerges of them.
      await tx.$executeRaw`SELECT 1 FROM board WHERE id = ${board.id} FOR UPDATE`;
      const posts = await tx.$queryRaw<{ duplicateOfId: string | null }[]>`
        SELECT "duplicateOfId" FROM post WHERE "boardId" = ${board.id} ORDER BY id FOR UPDATE`;
      if (posts.some((post) => !post.duplicateOfId)) {
        throw new OperationError(409, "conflict", "Only empty boards can be deleted. Move its posts to another board first.");
      }
      await tx.$executeRaw`
        UPDATE post SET "boardId" = original."boardId" FROM post original
        WHERE post."boardId" = ${board.id} AND original.id = post."duplicateOfId"`;
      await tx.board.delete({ where: { id: board.id } });
    });
    return {};
  },
});
