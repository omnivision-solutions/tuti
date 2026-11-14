"use server";

import { Prisma, prisma } from "@tuti/db";
import { boardLimit, effectivePlan, planDisplay, type PlanKey, upgradeFor } from "@tuti/shared";
import { refresh } from "next/cache";
import { z } from "zod";

import { BOARD_TEXT_LIMITS } from "@/lib/board-texts";
import { SLUG_PATTERN } from "@/lib/project-slugs";

import type { FormState } from "./form-state";
import { getAdminProject } from "./membership";

const nameSchema = z.string().trim().min(2, "Name is too short").max(60);
const descriptionSchema = z.string().trim().max(280).optional();

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, "Use lowercase letters, numbers and single dashes")
  .min(2)
  .max(40);

// Empty: the default words (lib/board-texts.ts).
const textSchema = (max: number) => z.string().trim().max(max, `Keep it to ${max} characters`).optional().transform((value) => value || null);

const boardSchema = z.object({
  name: nameSchema,
  slug: slugSchema,
  description: descriptionSchema,
  postButton: textSchema(BOARD_TEXT_LIMITS.postButton),
  titlePlaceholder: textSchema(BOARD_TEXT_LIMITS.titlePlaceholder),
  detailsPlaceholder: textSchema(BOARD_TEXT_LIMITS.detailsPlaceholder),
  // Who sees new posts on it (server/post-visibility.ts); a form without the field keeps what's saved.
  postVisibility: z.enum(["PUBLIC", "PRIVATE", "TEAM"]).optional(),
});

function parseBoard(formData: FormData) {
  const field = (name: string) => formData.get(name) ?? undefined;
  return boardSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description") || undefined,
    postButton: field("postButton"),
    titlePlaceholder: field("titlePlaceholder"),
    detailsPlaceholder: field("detailsPlaceholder"),
    postVisibility: field("postVisibility"),
  });
}

const DUPLICATE_SLUG = { error: "This project already has a board with that URL" };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const ADMIN_ONLY = { error: "Only project owners and admins can manage boards" };

const boardsFull = (plan: PlanKey, limit: number) =>
  [`Projects on the ${planDisplay(plan).name} plan have up to ${limit} feedback boards.`, upgradeFor(plan, boardLimit, " in Settings → Billing to add more.")].filter(Boolean).join(" ");

export async function createBoard(projectSlug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return ADMIN_ONLY;
  }
  const parsed = parseBoard(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, slug, description, postVisibility } = parsed.data;
  try {
    const full = await prisma.$transaction(async (tx) => {
      // Room on the plan, counted under the project's lock so two boards made at once can't both take the
      // last place. A project already past its limit (after a downgrade, or an import's boards turned off) keeps its
      // boards; it can't add more. Boards turned off count too, so turning one off never makes room for another.
      const [lockedRow] = await tx.$queryRaw<{ plan: PlanKey; trialEndsAt: Date | null }[]>`SELECT "planKey" AS plan, "trialEndsAt" FROM project WHERE id = ${project.id} FOR UPDATE`;
      const locked = lockedRow && { plan: effectivePlan(lockedRow.plan, lockedRow.trialEndsAt) };
      const limit = locked ? boardLimit(locked.plan) : null;
      if (locked && limit !== null && (await tx.board.count({ where: { projectId: project.id } })) >= limit) {
        return boardsFull(locked.plan, limit);
      }
      // Taking a slug that used to redirect to another board ends that redirect.
      await tx.boardRedirect.deleteMany({ where: { projectId: project.id, slug } });
      await tx.board.create({ data: { projectId: project.id, name, slug, description: description ?? null, postVisibility } });
      return null;
    });
    if (full) {
      return { error: full };
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return DUPLICATE_SLUG;
    }
    throw error;
  }
  refresh();
  return {};
}

/** Changing a board's URL keeps the old one working as a redirect. */
export async function updateBoard(
  projectSlug: string,
  boardId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return ADMIN_ONLY;
  }
  const parsed = parseBoard(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, slug, description, ...texts } = parsed.data;
  const board = await prisma.board.findFirst({ where: { id: boardId, projectId: project.id }, select: { slug: true } });
  if (!board) {
    return { error: "Board not found" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (slug !== board.slug) {
        await tx.boardRedirect.deleteMany({ where: { projectId: project.id, slug } });
        await tx.boardRedirect.upsert({
          where: { projectId_slug: { projectId: project.id, slug: board.slug } },
          create: { projectId: project.id, boardId, slug: board.slug },
          update: { boardId },
        });
      }
      await tx.board.update({ where: { id: boardId }, data: { name, slug, description: description ?? null, ...texts } });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return DUPLICATE_SLUG;
    }
    throw error;
  }
  refresh();
  return {};
}

/**
 * Turns a board off (Board.off: the team's alone, its posts off the portal) or on again, while the plan has room for
 * one more that's on: a project past its limit (an import's boards, brought off) turns them on after an upgrade.
 */
export async function setBoardOff(projectSlug: string, boardId: string, off: boolean): Promise<FormState> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return ADMIN_ONLY;
  }
  const error = await prisma.$transaction(async (tx) => {
    // The project's row locked as deleteBoard's (createBoard's lock waits on it too), so two can't both take the last place.
    const [lockedRow] = await tx.$queryRaw<{ plan: PlanKey; trialEndsAt: Date | null }[]>`SELECT "planKey" AS plan, "trialEndsAt" FROM project WHERE id = ${project.id} FOR NO KEY UPDATE`;
    const locked = lockedRow && { plan: effectivePlan(lockedRow.plan, lockedRow.trialEndsAt) };
    const board = await tx.board.findFirst({ where: { id: boardId, projectId: project.id }, select: { off: true } });
    if (!locked || !board) {
      return "Board not found";
    }
    const limit = boardLimit(locked.plan);
    if (board.off && !off && limit !== null && (await tx.board.count({ where: { projectId: project.id, off: false } })) >= limit) {
      return boardsFull(locked.plan, limit).replace("to add more", "to turn it on");
    }
    await tx.board.update({ where: { id: boardId }, data: { off } });
    if (off) {
      // Emails still due about its posts (a delayed job's, a retry's) go to nobody now, nor once it's turned on again.
      await tx.post.updateMany({ where: { boardId, shippedEmailsDueAt: { not: null } }, data: { shippedEmailsDueAt: null } });
      await tx.comment.updateMany({ where: { post: { boardId }, votersEmailDueAt: { not: null } }, data: { votersEmailDueAt: null } });
    }
    return null;
  });
  if (error) {
    return { error };
  }
  refresh();
  return {};
}

/**
 * Only empty boards can be deleted, and a project always keeps at least one. Merged duplicates don't count (they're in
 * no list, and Move to board can't reach them): they move to the boards of the posts they were merged into.
 */
export async function deleteBoard(projectSlug: string, boardId: string): Promise<FormState> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return ADMIN_ONLY;
  }
  const board = await prisma.board.findFirst({ where: { id: boardId, projectId: project.id }, select: { id: true } });
  if (!board) {
    return { error: "Board not found" };
  }
  const error = await prisma.$transaction(async (tx) => {
    // The project's row locked (createBoard's lock waits on it too), so two deletes can't both leave it without a board. Not
    // FOR UPDATE: that would block the key-share lock a post insert takes on it while holding the board's, a deadlock.
    await tx.$executeRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR NO KEY UPDATE`;
    if ((await tx.board.count({ where: { projectId: project.id } })) <= 1) {
      return "A project needs at least one board";
    }
    // The board's row locked holds off posts moved or added to it; its posts' rows, merges and unmerges of them.
    await tx.$executeRaw`SELECT 1 FROM board WHERE id = ${board.id} FOR UPDATE`;
    const posts = await tx.$queryRaw<{ duplicateOfId: string | null }[]>`
      SELECT "duplicateOfId" FROM post WHERE "boardId" = ${board.id} ORDER BY id FOR UPDATE`;
    if (posts.some((post) => !post.duplicateOfId)) {
      return "Only empty boards can be deleted. Move its posts to another board first.";
    }
    await tx.$executeRaw`
      UPDATE post SET "boardId" = original."boardId" FROM post original
      WHERE post."boardId" = ${board.id} AND original.id = post."duplicateOfId"`;
    await tx.board.delete({ where: { id: board.id } });
  });
  if (error) {
    return { error };
  }
  refresh();
  return {};
}
