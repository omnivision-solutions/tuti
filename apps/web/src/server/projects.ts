"use server";

import { Prisma, prisma } from "@tuti/db";
import { applyPlanLicense, grantLicenseCredits } from "@tuti/jobs";
import { log } from "@tuti/shared";
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
import { startTrial } from "./trials";

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
  // Reserved slugs aren't for projects, and Tuti's own portal's (ownPortal.project, reserved or not) is
  // only for its owner (ownPortal.owner, a verified address): nobody else can take it first.
  // Only where it can be served (not one of the app's own paths, see appPortalMount).
  const ownPortal = appPortalMount()?.slug === parsed.data.slug;
  if ((isReservedSlug(parsed.data.slug) || ownPortal) && !(ownPortal && isAppPortalOwner(session.user))) {
    return { error: "That URL is reserved" };
  }

  let licensed: string | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      const { id } = await tx.project.create({
        data: {
          name: parsed.data.name,
          slug: parsed.data.slug,
          team: { create: { userId: session.user.id, role: "OWNER" } },
          boards: { create: { slug: "feature-requests", name: "Feature requests" } },
        },
        select: { id: true },
      });
      // A license on the account with no project it could go on (what Licenses' "Create a project" is for: redeemed
      // before there was one) goes on this one, in place of a trial. One unassigned while there's a project to move it
      // to stays put. Locked, so assigning it elsewhere meanwhile waits and then finds it taken.
      const [idle] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM plan_license WHERE "userId" = ${session.user.id} AND "projectId" IS NULL AND "revokedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM team_member tm WHERE tm."userId" = ${session.user.id} AND tm.role IN ('OWNER', 'ADMIN') AND tm."projectId" <> ${id}
              AND NOT EXISTS (SELECT 1 FROM plan_license other WHERE other."projectId" = tm."projectId"))
        ORDER BY "claimedAt", id LIMIT 1 FOR UPDATE`;
      if (idle) {
        licensed = idle.id;
        await tx.planLicense.update({ where: { id: idle.id }, data: { projectId: id, assignedAt: new Date() } });
        await applyPlanLicense(tx, idle.id);
      } else {
        await startTrial(tx, id, session.user.id);
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "That URL is already taken" };
    }
    throw error;
  }
  if (licensed) {
    await grantLicenseCredits(licensed);
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
  try {
    await addSample(project.id, session.user.id);
  } catch (error) {
    log.error("Adding sample content failed", { error, projectId: project.id });
    return { error: "Couldn't add the sample content. Try again." };
  }
  refresh();
  return {};
}

/** Removes exactly the sample content, in one click. */
export async function removeSampleContent(projectSlug: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return SAMPLE_ADMIN_ONLY;
  }
  try {
    await removeSample(project.id);
  } catch (error) {
    log.error("Removing sample content failed", { error, projectId: project.id });
    return { error: "Couldn't remove the sample content. Try again." };
  }
  refresh();
  return {};
}
