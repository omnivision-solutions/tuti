import type { JobInput } from "@tuti/shared";

import { repositoryConnection } from "./github-repositories";
import { addToRunningDraft, closeRunningDraft, skipsChangelog } from "./running-draft";
import type { JobLogger, JobResult } from "./index";

/**
 * A merged pull request on an included repo goes into the changelog's running draft,
 * unless it's labelled as internal work. Nothing else happens to it yet: posts and
 * articles it changes are for code changes (docs/plan.md).
 */
export async function githubPullRequest(input: JobInput<"githubPullRequest">, log: JobLogger): Promise<JobResult> {
  const installation =
    input.action === "closed" && input.merged ? await repositoryConnection(input.installationId, { id: input.repoId, fullName: input.repo }) : null;
  if (!installation || skipsChangelog(input.labels)) {
    return { skipped: true };
  }
  const drafted = await addToRunningDraft(installation.project.id, { repo: input.repo, number: input.number, url: input.url, title: input.title });
  log.info(`${input.repo}#${input.number} merged${drafted ? ", added to the changelog draft" : ""}`);
  return { drafted };
}

/** A release was published: it closes the changelog's running draft (and names it). */
export async function githubRelease(input: JobInput<"githubRelease">, log: JobLogger): Promise<JobResult> {
  const installation = await repositoryConnection(input.installationId, { id: input.repoId, fullName: input.repo });
  if (!installation) {
    return { skipped: true };
  }
  const closed = await closeRunningDraft(installation.project.id, input.name);
  log.info(`${input.repo} ${input.tag}: ${closed ? "closed the changelog draft" : "no changelog draft to close"}`);
  return { closedDraft: closed ?? 0 };
}
