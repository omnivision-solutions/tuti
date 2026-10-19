import { prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";

import { emitEvent, portalOrigin, postSummary, postSummarySelect, toApiStatus } from "./events";
import type { JobLogger, JobResult } from "./index";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Post numbers a pull request mentions: `tuti#12` (as its own word), or a post's
 * URL on this project's portal: exactly its host (from PORTAL_URL_TEMPLATE), so
 * look-alikes like <project>.github.io don't count.
 */
export function referencedPosts(text: string, projectSlug: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/(?<![\w#/-])tuti#(\d{1,9})(?!\w)/gi)) {
    numbers.add(Number(match[1]));
  }
  const host = new URL(portalOrigin(projectSlug)).host;
  const portal = new RegExp(`https?://${escapeRegExp(host)}/p/(?:[a-z0-9-]*-)?(\\d{1,9})(?![\\w./-])`, "gi");
  for (const match of text.matchAll(portal)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers];
}

/** Statuses a newly opened pull request moves to In progress (later ones stay). */
const NOT_STARTED = new Set(["OPEN", "UNDER_REVIEW", "PLANNED"]);

/**
 * A pull request on a connected repo: links the posts it mentions to it, and
 * when it's opened (or reopened) moves them to In progress. Edits add links for
 * new mentions but never remove links or change statuses.
 */
export async function githubPullRequest(input: JobInput<"githubPullRequest">, log: JobLogger): Promise<JobResult> {
  const installation = await prisma.githubInstallation.findUnique({
    where: { installationId: input.installationId },
    select: { projectId: true, project: { select: { slug: true } } },
  });
  if (!installation) {
    return { skipped: true };
  }
  const { projectId, project } = installation;
  const numbers = referencedPosts(`${input.title}\n${input.body}`, project.slug);
  if (numbers.length === 0) {
    return { linked: 0 };
  }
  const posts = await prisma.post.findMany({
    where: { projectId, number: { in: numbers }, duplicateOfId: null },
    select: { ...postSummarySelect, id: true },
  });

  let started = 0;
  for (const post of posts) {
    await prisma.postLink.upsert({
      where: { postId_url: { postId: post.id, url: input.url } },
      update: { title: input.title },
      create: {
        projectId,
        postId: post.id,
        kind: "PULL_REQUEST",
        repo: input.repo,
        number: input.number,
        url: input.url,
        title: input.title,
        source: "REFERENCE",
      },
    });
    if ((input.action === "opened" || input.action === "reopened") && NOT_STARTED.has(post.status)) {
      // Only from the status we read: the team may have changed it meanwhile, or a
      // redelivery of this event may have got here first.
      const { count } = await prisma.post.updateMany({
        where: { id: post.id, status: post.status },
        data: { status: "IN_PROGRESS" },
      });
      if (count === 0) {
        continue;
      }
      const updated = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: postSummarySelect });
      await emitEvent(projectId, "post.status_changed", {
        post: postSummary(updated, project.slug),
        previousStatus: toApiStatus(post.status),
      });
      started++;
    }
  }
  log.info(`${input.repo}#${input.number}: linked ${posts.length} post(s), ${started} now in progress`);
  return { linked: posts.length, started };
}
