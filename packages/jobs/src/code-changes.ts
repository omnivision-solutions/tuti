import { prisma } from "@tuti/db";
import { codeChangesEnabled, type JobInput } from "@tuti/shared";

import { installationApi } from "./github-api";
import { enqueue, type JobLogger, type JobResult } from "./index";
import { readPullRequest } from "./pull-request";

/**
 * Code changes (docs/plan.md): every pull request merged on a project's repositories is read once
 * and analysed into actions the team applies. Nothing customer-facing changes until someone does.
 */

type MergedPullRequest = { repoId: number; repo: string; number: number; url: string; title: string; author: string; mergedAt: string };

/**
 * A merged pull request becomes the project's code change, analysed by the `code-change` job, unless
 * analysis is off (on this server, or by the team). A redelivery finds the one it made: queued again
 * only while it isn't analysed yet, and analysed once (the job checks). Returns whether there is one.
 */
export async function startCodeChange(projectId: string, pr: MergedPullRequest): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { analyseCodeChanges: true } });
  if (!codeChangesEnabled() || !project?.analyseCodeChanges) {
    return false;
  }
  const change = await prisma.codeChange.upsert({
    where: { projectId_repoId_number: { projectId, repoId: pr.repoId, number: pr.number } },
    create: { projectId, repoId: pr.repoId, repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, author: pr.author, mergedAt: new Date(pr.mergedAt) },
    update: {},
    select: { id: true, state: true },
  });
  if (change.state === "ANALYSING" || change.state === "FAILED") {
    await enqueue("codeChange", { codeChangeId: change.id, force: false });
  }
  return true;
}

/** Reads the pull request with the installation's token, then analyses it. Logs keep ids and counts, never its text. */
export async function codeChange(input: JobInput<"codeChange">, log: JobLogger): Promise<JobResult> {
  const change = await prisma.codeChange.findUnique({
    where: { id: input.codeChangeId },
    select: { id: true, projectId: true, repoId: true, repo: true, number: true, state: true, project: { select: { analyseCodeChanges: true } } },
  });
  if (!change) {
    return { skipped: true };
  }
  // Analysed once: a redelivery or a second run finds it done.
  if (!input.force && (change.state === "READY" || change.state === "NOTHING_TO_DO")) {
    return { skipped: true };
  }
  const waiting = { id: change.id, state: { in: ["ANALYSING" as const, "FAILED" as const] } };
  // Turned off since it merged: nothing is sent, and it isn't kept waiting.
  if (!change.project.analyseCodeChanges) {
    await prisma.codeChange.deleteMany({ where: waiting });
    return { skipped: true };
  }
  if (!codeChangesEnabled()) {
    await prisma.codeChange.updateMany({ where: waiting, data: { state: "FAILED", reason: "AI isn't set up on this server." } });
    return { skipped: true };
  }
  // Still one of the project's repositories, on the installation it's connected to now.
  const repository = await prisma.githubRepository.findUnique({
    where: { repoId: change.repoId },
    select: { fullName: true, connection: { select: { projectId: true, installationId: true } } },
  });
  if (repository?.connection.projectId !== change.projectId) {
    await prisma.codeChange.update({ where: { id: change.id }, data: { state: "FAILED", reason: "The repository isn't in this project any more." } });
    return { skipped: true };
  }
  await prisma.codeChange.update({ where: { id: change.id }, data: { state: "ANALYSING", reason: "" } });
  try {
    const pr = await readPullRequest(await installationApi(repository.connection.installationId), repository.fullName, change.number);
    await prisma.codeChange.update({
      where: { id: change.id },
      data: { title: pr.title, author: pr.author, mergedAt: new Date(pr.mergedAt) },
    });
    const read = pr.files.filter((file) => !file.left).length;
    log.info(`Code change ${change.id} (${change.repo}#${change.number}): read ${read} of ${pr.files.length} files, ${pr.diff.length} characters of diff`);
    return { files: pr.files.length, read };
  } catch (error) {
    // Retried (Hatchet), and the team sees where it stopped meanwhile.
    await prisma.codeChange.update({ where: { id: change.id }, data: { state: "FAILED", reason: "GitHub didn't let Tuti read the pull request." } });
    throw error;
  }
}
