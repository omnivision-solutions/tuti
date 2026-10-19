"use server";

import { prisma } from "@tuti/db";
import { refresh } from "next/cache";

import { getAdminProject } from "./membership";

/** Disconnects GitHub from the project here (the App stays installed on GitHub until removed there). */
export async function disconnectGithub(projectSlug: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can change the GitHub connection" };
  }
  const { count } = await prisma.githubInstallation.deleteMany({ where: { projectId: project.id } });
  if (count === 0) {
    return { error: "GitHub isn't connected" };
  }
  refresh();
  return {};
}
