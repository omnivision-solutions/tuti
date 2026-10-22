"use server";

import { prisma } from "@tuti/db";
import { includeRepositories, inInstallation, listedRepositories } from "@tuti/jobs";
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
  // No refresh(): the page it's on (GitHub's settings) would redirect, adding to the history;
  // the button goes on to Integrations itself.
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

/**
 * Adds a repository to the project (its pull requests and releases link to and complete the
 * project's posts) or removes it. Only repositories the project has seen (listed in its
 * settings) can be included, and only one project includes each.
 */
export async function setGithubRepository(projectSlug: string, repoId: number, included: boolean): Promise<{ error?: string }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can change the GitHub connection" };
  }
  if (!Number.isSafeInteger(repoId)) {
    return { error: "Unknown repository" };
  }
  const connection = await prisma.githubInstallation.findUnique({
    where: { projectId: project.id },
    select: { id: true, installationId: true, repositories: true },
  });
  if (!connection) {
    return { error: "GitHub isn't connected" };
  }
  if (!included) {
    await prisma.githubRepository.deleteMany({ where: { connectionId: connection.id, repoId } });
    refresh();
    return {};
  }
  const repo = listedRepositories(connection.repositories).find((r) => r.id === repoId);
  if (!repo) {
    return { error: "Refresh the list: that repository isn't one this project can include" };
  }
  await prisma.githubRepository.createMany({ data: { connectionId: connection.id, repoId, fullName: repo.fullName }, skipDuplicates: true });
  const holder = await prisma.githubRepository.findUnique({
    where: { repoId },
    select: { connectionId: true, connection: { select: { installationId: true } } },
  });
  if (holder?.connectionId !== connection.id) {
    // Held from another installation: it was there once, and may have moved here since. The list
    // may be older than a move, so only GitHub's word now takes it from that project.
    let moved = false;
    if (holder && holder.connection.installationId !== connection.installationId) {
      try {
        moved = await inInstallation(connection.installationId, repoId);
      } catch {
        return { error: `GitHub couldn't say where ${repo.fullName} is now. Try again in a moment.` };
      }
    }
    if (!moved) {
      return { error: `${repo.fullName} is in another project` };
    }
    await includeRepositories(connection.id, connection.installationId, [repo], { takeOver: true });
    const now = await prisma.githubRepository.findUnique({ where: { repoId }, select: { connectionId: true } });
    if (now?.connectionId !== connection.id) {
      return { error: `${repo.fullName} is in another project` };
    }
  }
  refresh();
  return {};
}
