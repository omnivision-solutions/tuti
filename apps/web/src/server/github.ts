"use server";

import { prisma } from "@tuti/db";
import { includeRepositories, inInstallation, listedRepositories, syncRepositories } from "@tuti/jobs";
import { refresh } from "next/cache";

import type { FormState } from "./form-state";
import { getAdminProject, getOwnerProject } from "./membership";
import { getSession } from "./session";

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

/**
 * Adds a repository to the project (its merged pull requests go into the project's changelog
 * draft) or removes it. Only repositories the project has seen (listed in its
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

/**
 * "Refresh list": every repository the Tuti App can see on the account, from GitHub now (with the
 * App's own access, no trip to GitHub). The project's repositories GitHub no longer has leave it.
 */
export async function refreshGithubRepositories(projectSlug: string): Promise<{ error?: string; count?: number }> {
  const project = await getAdminProject(projectSlug);
  if (!project) {
    return { error: "Only project owners and admins can change the GitHub connection" };
  }
  const connection = await prisma.githubInstallation.findUnique({ where: { projectId: project.id }, select: { id: true, installationId: true } });
  if (!connection) {
    return { error: "GitHub isn't connected" };
  }
  try {
    const repositories = await syncRepositories(connection.id, connection.installationId);
    refresh();
    return { count: repositories.length };
  } catch {
    return { error: "GitHub didn't answer. Try again in a moment." };
  }
}

/** Turns code changes (merged pull requests read and analysed by the AI provider) on or off for the project. */
export async function setCodeChangeAnalysis(projectSlug: string, on: boolean): Promise<{ error?: string }> {
  // Autopilot's settings are the owners' (Settings → AI → Autopilot).
  const project = await getOwnerProject(projectSlug);
  if (!project) {
    return { error: "Only project owners can change Autopilot's settings" };
  }
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: on === true } });
  refresh();
  return {};
}

/** Lets Tuti apply a code change's "links" proposals by itself when it's very sure (only links: nothing users see). */
export async function setAutoApplyLinks(projectSlug: string, on: boolean): Promise<{ error?: string }> {
  // Autopilot's settings are the owners' (Settings → AI → Autopilot).
  const project = await getOwnerProject(projectSlug);
  if (!project) {
    return { error: "Only project owners can change Autopilot's settings" };
  }
  await prisma.project.update({ where: { id: project.id }, data: { autoApplyLinks: on === true } });
  refresh();
  return {};
}

/**
 * Settings → Autopilot (owners): what it does by itself (switches, unticked = off) and what always waits
 * for someone (how sure, how many people a post reaches, how often an article is read), and the hold.
 */
export async function saveAutopilotSettings(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const project = await getOwnerProject(projectSlug);
  if (!project) {
    return { error: "Only project owners can change Autopilot's settings" };
  }
  // Missing or blank isn't 0 (Number("") is): a request without the hold mustn't save none.
  const whole = (name: string, min: number, max: number) => {
    const raw = formData.get(name);
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
  };
  const minSure = whole("minSure", 50, 100);
  const maxReach = whole("maxReach", 1, 100_000);
  const maxViews = whole("maxViews", 1, 10_000_000);
  const holdHours = whole("holdHours", 0, 24 * 14);
  if (minSure === null || maxReach === null || maxViews === null || holdHours === null) {
    return { error: "How sure is 50 to 100%, people and views at least 1, and the hold 0 to 336 hours (two weeks)" };
  }
  const on = (name: string) => formData.get(name) === "on";
  await prisma.project.update({
    where: { id: project.id },
    data: {
      autopilotDrafts: on("drafts"),
      autopilotArticleEdits: on("articleEdits"),
      autopilotProgress: on("progress"),
      autopilotComplete: on("complete"),
      autopilotMinSure: minSure,
      autopilotMaxReach: maxReach,
      autopilotMaxViews: maxViews,
      autopilotHoldHours: holdHours,
    },
  });
  refresh();
  return {};
}

/**
 * Settings → Autopilot → Who's told (owners): owners always are; admins too when ticked (`admins`), and
 * the team members picked (`told`, their user ids).
 */
export async function saveAutopilotRecipients(projectSlug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const project = await getOwnerProject(projectSlug);
  if (!project) {
    return { error: "Only project owners can change Autopilot's settings" };
  }
  const told = formData.getAll("told").map(String);
  await prisma.$transaction([
    prisma.project.update({ where: { id: project.id }, data: { autopilotTellAdmins: formData.get("admins") === "on" } }),
    prisma.teamMember.updateMany({ where: { projectId: project.id }, data: { autopilotTold: false } }),
    prisma.teamMember.updateMany({ where: { projectId: project.id, userId: { in: told } }, data: { autopilotTold: true } }),
  ]);
  refresh();
  return {};
}

/** Account → Autopilot's email: as each change is analysed, or off (owners still hear what goes out by itself). */
export async function setAutopilotEmails(choice: string): Promise<FormState> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in first" };
  }
  if (choice !== "AS_THEY_HAPPEN" && choice !== "OFF") {
    return { error: "Pick when you hear from Autopilot" };
  }
  await prisma.user.update({ where: { id: session.user.id }, data: { autopilotEmails: choice } });
  refresh();
  return {};
}
