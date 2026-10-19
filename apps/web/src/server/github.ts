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

/** When linked posts become Completed: when a release ships them (default) or when their pull request is merged. */
export async function setGithubCloseOn(projectSlug: string, closeOn: string): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can change the GitHub connection" };
  }
  if (closeOn !== "RELEASE" && closeOn !== "MERGE") {
    return { error: "Unknown choice" };
  }
  const { count } = await prisma.githubInstallation.updateMany({ where: { projectId: project.id }, data: { closeOn } });
  if (count === 0) {
    return { error: "GitHub isn't connected" };
  }
  refresh();
  return {};
}

/** Whether Tuti comments on pull requests that link posts, listing the feedback they complete. */
export async function setGithubPrComments(projectSlug: string, on: boolean): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can change the GitHub connection" };
  }
  const { count } = await prisma.githubInstallation.updateMany({
    where: { projectId: project.id },
    data: { commentOnPullRequests: on === true },
  });
  if (count === 0) {
    return { error: "GitHub isn't connected" };
  }
  refresh();
  return {};
}
