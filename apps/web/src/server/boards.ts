"use server";

import { Prisma, prisma } from "@tuti/db";
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
  });
}

const DUPLICATE_SLUG = { error: "This project already has a board with that URL" };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const ADMIN_ONLY = { error: "Only project owners and admins can manage boards" };

export async function createBoard(projectSlug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return ADMIN_ONLY;
  }
  const parsed = parseBoard(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, slug, description } = parsed.data;
  try {
    await prisma.$transaction([
      // Taking a slug that used to redirect to another board ends that redirect.
      prisma.boardRedirect.deleteMany({ where: { projectId: project.id, slug } }),
      prisma.board.create({ data: { projectId: project.id, name, slug, description: description ?? null } }),
    ]);
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

/** Only empty boards can be deleted, and a project always keeps at least one. */
export async function deleteBoard(projectSlug: string, boardId: string): Promise<FormState> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return ADMIN_ONLY;
  }
  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId: project.id },
    select: { id: true, _count: { select: { posts: true } } },
  });
  if (!board) {
    return { error: "Board not found" };
  }
  if (board._count.posts > 0) {
    return { error: "Only empty boards can be deleted. Move its posts to another board first." };
  }
  if ((await prisma.board.count({ where: { projectId: project.id } })) <= 1) {
    return { error: "A project needs at least one board" };
  }
  await prisma.board.delete({ where: { id: board.id } });
  refresh();
  return {};
}
