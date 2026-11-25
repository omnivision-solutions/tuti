import type { JobInput } from "@tuti/shared";

import { syncMergedApiReferences } from "./api-references";
import { analysisOn, startCodeChange } from "./code-changes";
import { installationApi } from "./github-api";
import { repositoryConnection } from "./github-repositories";
import { addToRunningDraft, closeRunningDraft, skipsChangelog } from "./running-draft";
import type { JobLogger, JobResult } from "./index";

/**
 * A merged pull request on an included repo goes into the changelog's running draft (unless it's
 * labelled as internal work) and becomes a code change, which proposes the posts and articles it
 * changes (docs/plan.md). API references read from the branch it merged into are read again when it changed their file.
 */
export async function githubPullRequest(input: JobInput<"githubPullRequest">, log: JobLogger): Promise<JobResult> {
  const installation =
    input.action === "closed" && input.merged ? await repositoryConnection(input.installationId, { id: input.repoId, fullName: input.repo }) : null;
  if (!installation) {
    return { skipped: true };
  }
  const projectId = installation.project.id;
  const pr = { repo: input.repo, number: input.number, url: input.url, title: input.title };
  // With code changes on, their gate decides what the changelog hears about (it takes the bullet out
  // again, and a redelivery after that doesn't put it back); without them, labels for internal work keep it out.
  const codeChangesOn = await analysisOn(projectId);
  const drafted =
    (codeChangesOn || !skipsChangelog(input.labels)) && (await addToRunningDraft(projectId, { ...pr, repoId: input.repoId }, codeChangesOn ? { repoId: input.repoId } : undefined));
  const analysed = await startCodeChange(projectId, {
    ...pr,
    repoId: input.repoId,
    author: input.author,
    mergedAt: input.mergedAt ?? new Date().toISOString(),
  });
  // Last, and on its own: a reference that can't be read says so on its page, and stops none of the rest.
  let references = { synced: 0, failed: 0 };
  if (input.base) {
    try {
      references = await syncMergedApiReferences(projectId, { repoId: input.repoId, base: input.base }, async () => {
        type File = { filename: string; previous_filename?: string };
        // GitHub lists at most 3,000 files for a pull request, 100 a page.
        return (await installationApi(input.installationId)).list<File>(`/repos/${input.repo}/pulls/${input.number}/files`, (page) => page as File[], 30);
      }, log);
    } catch (error) {
      log.warn(`Syncing API references after ${input.repo}#${input.number} failed: ${String(error)}`);
    }
  }
  log.info(
    `${input.repo}#${input.number} merged${drafted ? ", added to the changelog draft" : ""}${analysed ? ", a code change" : ""}${references.synced + references.failed ? `, ${references.synced + references.failed} API references synced` : ""}`,
  );
  return { drafted, analysed, references: references.synced };
}

/** A release was published: it closes the changelog's running draft (and names it). */
export async function githubRelease(input: JobInput<"githubRelease">, log: JobLogger): Promise<JobResult> {
  const installation = await repositoryConnection(input.installationId, { id: input.repoId, fullName: input.repo });
  if (!installation) {
    return { skipped: true };
  }
  const published = new Date(input.publishedAt);
  const closed = await closeRunningDraft(installation.project.id, input.name, Number.isNaN(published.getTime()) ? new Date() : published);
  log.info(`${input.repo} ${input.tag}: ${closed ? "closed the changelog draft" : "no changelog draft to close"}`);
  return { closedDraft: closed ?? 0 };
}
