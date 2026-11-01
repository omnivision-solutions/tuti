"use server";

import { Prisma, prisma } from "@tuti/db";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { appPortalMount, isAppPortalOwner } from "@/lib/app-portal";
import type { ProjectUse } from "@/lib/project-uses";
import { isReservedSlug, SLUG_PATTERN } from "@/lib/project-slugs";

import type { FormState } from "./form-state";
import { getAdminProject } from "./membership";
import { updateProject } from "./operations/more";
import { asAdmin, call } from "./operations/run";
import { addSampleContent as addSample, removeSampleContent as removeSample } from "./sample-content";
import { getAccountSession, getSession } from "./session";

const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, "Use lowercase letters, numbers and single dashes")
    .min(2)
    .max(40),
});

export async function createProject(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getAccountSession();
  if (!session) {
    return { error: "Sign in to create a project" };
  }

  const parsed = createProjectSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  // Reserved slugs aren't for projects, and Tuti's own portal's (APP_PORTAL_PROJECT, reserved or not) is
  // only for its owner (APP_PORTAL_OWNER, a verified address): nobody else can take it first.
  // Only where it can be served (not one of the app's own paths, see appPortalMount).
  const ownPortal = appPortalMount()?.slug === parsed.data.slug;
  if ((isReservedSlug(parsed.data.slug) || ownPortal) && !(ownPortal && isAppPortalOwner(session.user))) {
    return { error: "That URL is reserved" };
  }

  try {
    await prisma.project.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        team: { create: { userId: session.user.id, role: "OWNER" } },
        boards: { create: { slug: "feature-requests", name: "Feature requests" } },
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "That URL is already taken" };
    }
    throw error;
  }

  // The /app layout lists your projects; refresh it before navigating. Then the first run's setup, every step skippable.
  revalidatePath("/app", "layout");
  redirect(`/app/${parsed.data.slug}/setup`);
}

/** The first run's "What will you use?": Home's "Get set up" follows it (project.update's `uses`). */
export async function setProjectUses(projectSlug: string, uses: string[]): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can set up the project", (context) =>
    call(updateProject, context, { uses: (Array.isArray(uses) ? uses.map(String) : []) as ProjectUse[] }),
  );
}

const SAMPLE_ADMIN_ONLY = { error: "Only project owners and admins can add or remove sample content" };

/** Sample content to try things with, for the project's picks (server/sample-content.ts). */
export async function addSampleContent(projectSlug: string): Promise<{ error?: string }> {
  const [session, project] = await Promise.all([getSession(), getAdminProject(projectSlug)]);
  if (!session || !project) {
    return SAMPLE_ADMIN_ONLY;
  }
  await addSample(project.id, session.user.id);
  refresh();
  return {};
}

/** Removes exactly the sample content, in one click. */
export async function removeSampleContent(projectSlug: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return SAMPLE_ADMIN_ONLY;
  }
  await removeSample(project.id);
  refresh();
  return {};
}
