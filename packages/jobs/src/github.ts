import { type PostStatus, prisma } from "@tuti/db";
import { embed, embeddingsEnabled, LINK_MIN_SIMILARITY, type JobInput, toVectorLiteral } from "@tuti/shared";

import { portalOrigin, portalPostUrl, postStatusChanged, postSummary, postSummarySelect } from "./events";
import { portalAddress } from "./portal-address";
import { installationApi } from "./github-api";
import { repositoryConnection } from "./github-repositories";
import { addToRunningDraft, closeRunningDraft, skipsChangelog } from "./running-draft";
import type { JobLogger, JobResult } from "./index";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Post numbers a pull request mentions: `tuti#12` (as its own word), or a post's
 * URL on this project's portal: exactly one of its addresses (`portals`: its Tuti
 * address, and its custom domain), so look-alikes like <project>.github.io don't count.
 */
export function referencedPosts(text: string, portals: string[]): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/(?<![\w#/-])tuti#(\d{1,9})(?!\w)/gi)) {
    numbers.add(Number(match[1]));
  }
  for (const origin of portals) {
    const portal = new RegExp(`https?://${escapeRegExp(new URL(origin).host)}/feedback/[a-z0-9-]+/(?:[a-z0-9-]*-)?(\\d{1,9})(?![\\w./-])`, "gi");
    for (const match of text.matchAll(portal)) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers];
}

/** Statuses a newly opened pull request moves to In progress (later ones stay). */
const NOT_STARTED = new Set(["OPEN", "UNDER_REVIEW", "PLANNED"]);

/**
 * A pull request on an included repo: links the posts it mentions (in its title,
 * description or commit messages) to it, and when it's opened (or reopened) moves
 * them to In progress. Edits and new commits add links for new mentions but never
 * remove links or change statuses.
 */
export async function githubPullRequest(input: JobInput<"githubPullRequest">, log: JobLogger): Promise<JobResult> {
  if (input.action === "closed") {
    return completeOnMerge(input, log);
  }
  const installation = await repositoryConnection(input.installationId, { id: input.repoId, fullName: input.repo });
  if (!installation) {
    return { skipped: true };
  }
  const { project } = installation;
  const projectId = project.id;
  // Commit messages change when it's opened, reopened or pushed to; an edit only changes the title or description.
  const commits = input.action === "edited" ? [] : await commitMessages(input);
  // Before any status changes: if it failed after, a retry wouldn't find the posts to tell the webhooks.
  const portal = await portalAddress(project.slug);
  // A link to the post at either of the portal's addresses.
  const portals = [...new Set([portalOrigin(project.slug), portal])];
  const numbers = referencedPosts([input.title, input.body, ...commits].join("\n"), portals);
  const posts =
    numbers.length === 0
      ? []
      : await prisma.post.findMany({
          where: { projectId, number: { in: numbers }, duplicateOfId: null },
          select: { ...postSummarySelect, id: true },
        });

  let started = 0;
  for (const post of posts) {
    // Linked now, so no longer a suggestion (together: a failed link keeps the suggestion).
    await prisma.$transaction(async (tx) => {
      await tx.linkSuggestion.deleteMany({ where: { postId: post.id, url: input.url } });
      await tx.postLink.upsert({
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
      await postStatusChanged(projectId, post.id, postSummary(updated, portal), post.status);
      started++;
    }
  }
  let commented = false;
  if (installation.commentOnPullRequests && posts.length > 0) {
    try {
      await commentFeedback(input, project);
      commented = true;
    } catch (error) {
      // Linking worked; a missing permission (or GitHub down) only costs the comment.
      log.warn(`couldn't comment on ${input.repo}#${input.number}: ${(error as Error).message}`);
    }
  }
  // A renamed pull request: suggestions waiting for the team show its new title.
  await prisma.linkSuggestion.updateMany({
    where: { projectId, url: input.url, status: "PENDING" },
    data: { title: input.title },
  });
  let suggested = 0;
  // New commits don't change the pull request's text, which is what suggestions compare.
  if (embeddingsEnabled() && input.action !== "synchronize") {
    try {
      suggested = await suggestLinks(input, projectId);
    } catch (error) {
      // Suggestions are a nicety: an embeddings outage doesn't fail the pull request.
      log.warn(`couldn't suggest posts for ${input.repo}#${input.number}: ${(error as Error).message}`);
    }
  }
  log.info(`${input.repo}#${input.number}: linked ${posts.length} post(s), ${started} now in progress, ${suggested} suggested`);
  return { linked: posts.length, started, commented, suggested };
}

/** Commit messages of a pull request. GitHub lists at most 250 per pull request; 3 pages of 100 cover them. */
async function commitMessages(input: JobInput<"githubPullRequest">): Promise<string[]> {
  const api = await installationApi(input.installationId);
  type Commit = { commit: { message: string } };
  const commits = await api.list<Commit>(`/repos/${input.repo}/pulls/${input.number}/commits`, (page) => page as Commit[], 3);
  return commits.map((c) => c.commit.message);
}

const MAX_SUGGESTIONS = 3;

/**
 * Posts a pull request may be about without mentioning them: open posts whose
 * text is close to the PR's (embeddings), for the team to link or dismiss.
 * Posts already linked to it or suggested for it (pending or dismissed), done
 * or merged aren't suggested. Returns how many new suggestions were added.
 */
async function suggestLinks(input: JobInput<"githubPullRequest">, projectId: string): Promise<number> {
  // Up to 3 waiting at a time per pull request; dismissing some makes room for others.
  const waiting = await prisma.linkSuggestion.count({ where: { projectId, url: input.url, status: "PENDING" } });
  const room = MAX_SUGGESTIONS - waiting;
  if (room <= 0) {
    return 0;
  }
  const [vector] = await embed([`${input.title}\n\n${input.body}`.trim().slice(0, 8000)]);
  const literal = toVectorLiteral(vector!);
  const matches = await prisma.$queryRaw<{ postId: string; similarity: number }[]>`
    SELECT e."postId", 1 - (e.embedding <=> ${literal}::vector) AS similarity
    FROM post_embedding e
    JOIN post p ON p.id = e."postId"
    WHERE e."projectId" = ${projectId}
      AND p."duplicateOfId" IS NULL
      AND p.status NOT IN ('COMPLETED', 'CLOSED')
      AND NOT EXISTS (SELECT 1 FROM post_link l WHERE l."postId" = p.id AND l.url = ${input.url})
      -- Already suggested (or dismissed): the room is for posts not suggested yet.
      AND NOT EXISTS (SELECT 1 FROM link_suggestion s WHERE s."postId" = p.id AND s.url = ${input.url})
    ORDER BY e.embedding <=> ${literal}::vector
    LIMIT ${room}`;
  const likely = matches.filter((m) => m.similarity >= LINK_MIN_SIMILARITY);
  if (likely.length === 0) {
    return 0;
  }
  const { count } = await prisma.linkSuggestion.createMany({
    data: likely.map((m) => ({
      projectId,
      postId: m.postId,
      repo: input.repo,
      number: input.number,
      url: input.url,
      title: input.title,
      similarity: m.similarity,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** Post titles are people's text: no Markdown, links, @mentions or #references in the comment. */
const plain = (text: string) => text.replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, "\\$&").replaceAll("@", "@&#8203;");

/**
 * Tuti's one comment on a pull request: the feedback it completes (every post
 * linked to it), most voted first. Updated in place as more posts get linked:
 * its id is saved here, and jobs for one pull request run one at a time (see
 * `concurrencyKey` in @tuti/shared's jobs), so two can't both write one.
 */
async function commentFeedback(
  input: JobInput<"githubPullRequest">,
  project: { id: string; slug: string; name: string },
) {
  const posts = await prisma.post.findMany({
    where: { projectId: project.id, duplicateOfId: null, links: { some: { url: input.url } } },
    orderBy: [{ voteCount: "desc" }, { number: "asc" }],
    select: { number: true, title: true, voteCount: true, board: { select: { slug: true } } },
  });
  const portal = await portalAddress(project.slug);
  const lines = posts.map(
    (post) => `- [${plain(post.title)}](${portalPostUrl(portal, post)}) · ${post.voteCount} ${post.voteCount === 1 ? "vote" : "votes"}`,
  );
  const body = `**Feedback this pull request completes** (${plain(project.name)})\n\n${lines.join("\n")}`;

  const where = { repo_number: { repo: input.repo, number: input.number } };
  const saved = await prisma.githubPrComment.findUnique({ where, select: { commentId: true, body: true } });
  if (saved?.body === body) {
    return;
  }
  const api = await installationApi(input.installationId);
  type Comment = { id: number };
  let comment = saved
    ? await api.send<Comment>("PATCH", `/repos/${input.repo}/issues/comments/${saved.commentId}`, { body })
    : null;
  // None yet, or someone deleted ours: write one.
  comment ??= await api.send<Comment>("POST", `/repos/${input.repo}/issues/${input.number}/comments`, { body });
  if (!comment) {
    throw new Error("GitHub doesn't know this pull request");
  }
  const data = { commentId: BigInt(comment.id), body };
  await prisma.githubPrComment.upsert({
    where,
    create: { repo: input.repo, number: input.number, projectId: project.id, ...data },
    update: data,
  });
}

/** Moves posts to a status (only from the status they're in now) and tells the project's webhooks. */
async function moveTo(
  status: PostStatus,
  project: { id: string; slug: string },
  posts: { id: string; status: PostStatus }[],
): Promise<number> {
  let moved = 0;
  // Before any status changes (see githubPullRequest).
  const portal = await portalAddress(project.slug);
  for (const post of posts) {
    const { count } = await prisma.post.updateMany({ where: { id: post.id, status: post.status }, data: { status } });
    if (count === 0) {
      continue;
    }
    const updated = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, select: postSummarySelect });
    await postStatusChanged(project.id, post.id, postSummary(updated, portal), post.status);
    moved++;
  }
  return moved;
}

/** Statuses that shipping a post's pull request completes (not Completed or Closed already). */
const NOT_DONE: PostStatus[] = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS"];

/** Unmerged posts linked to these pull requests of a repo, that aren't done yet. */
const linkedPosts = (projectId: string, repo: string, numbers: number[]) =>
  prisma.post.findMany({
    where: {
      projectId,
      duplicateOfId: null,
      status: { in: NOT_DONE },
      links: { some: { kind: "PULL_REQUEST", repo, number: { in: numbers } } },
    },
    select: { id: true, status: true, links: { where: { kind: "PULL_REQUEST", repo }, select: { number: true } } },
  });

/** For projects that close on merge (no releases): a merged pull request completes its posts. */
export async function completeOnMerge(input: JobInput<"githubPullRequest">, log: JobLogger): Promise<JobResult> {
  const installation = input.merged ? await repositoryConnection(input.installationId, { id: input.repoId, fullName: input.repo }) : null;
  if (!installation) {
    return { skipped: true };
  }
  // Every merged pull request goes into the changelog's running draft, unless it's labelled as internal work.
  const drafted =
    !skipsChangelog(input.labels) &&
    (await addToRunningDraft(installation.project.id, { repo: input.repo, number: input.number, url: input.url, title: input.title }));
  if (installation.closeOn !== "MERGE") {
    log.info(`${input.repo}#${input.number} merged${drafted ? ", added to the changelog draft" : ""}`);
    return { drafted };
  }
  const posts = await linkedPosts(installation.project.id, input.repo, [input.number]);
  const completed = await moveTo("COMPLETED", installation.project, posts);
  log.info(`${input.repo}#${input.number} merged: ${completed} post(s) completed${drafted ? ", added to the changelog draft" : ""}`);
  return { completed, drafted };
}

type GithubPull = { merged_at: string | null; merge_commit_sha: string | null };
type GithubRelease = { tag_name: string; draft: boolean; published_at: string | null };

/**
 * A release was published: posts linked to pull requests it ships become
 * Completed, with the release linked. A pull request ships in this release if its
 * merge commit is in this release's tag but not in the previous release's (or, for
 * a repo's first release, simply in this one). GitHub's compare of the commit with
 * each tag tells, however many commits lie between the releases.
 */
export async function githubRelease(input: JobInput<"githubRelease">, log: JobLogger): Promise<JobResult> {
  const installation = await repositoryConnection(input.installationId, { id: input.repoId, fullName: input.repo });
  if (!installation) {
    return { skipped: true };
  }
  // The release closes the changelog's running draft, whatever completes posts.
  const closed = await closeRunningDraft(installation.project.id, input.name);
  if (installation.closeOn !== "RELEASE") {
    return { closedDraft: closed ?? 0 };
  }
  const { project } = installation;
  const candidates = await prisma.postLink.findMany({
    where: {
      projectId: project.id,
      kind: "PULL_REQUEST",
      repo: input.repo,
      number: { not: null },
      post: { status: { in: NOT_DONE }, duplicateOfId: null },
    },
    select: { number: true },
    distinct: ["number"],
  });
  if (candidates.length === 0) {
    return { completed: 0 };
  }

  const api = await installationApi(input.installationId);
  const RELEASE_PAGES = 20;
  const releases = await api.list<GithubRelease>(`/repos/${input.repo}/releases`, (page) => page as GithubRelease[], RELEASE_PAGES);
  const previous = releases
    .filter((r) => !r.draft && r.published_at && r.tag_name !== input.tag)
    .filter((r) => Date.parse(r.published_at!) < Date.parse(input.publishedAt))
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!))[0];
  // Without a previous release this counts as the repo's first, which ships everything merged so far.
  // If the list may have been cut off, the real previous release could be missing: complete nothing.
  if (!previous && releases.length >= RELEASE_PAGES * 100) {
    log.warn(`${input.repo} ${input.tag}: couldn't find the previous release among ${releases.length}; nothing completed`);
    return { completed: 0, skipped: true };
  }
  /** Whether a commit is part of a tag (the tag is it, or comes after it). */
  const contains = async (tag: string, sha: string) => {
    const comparison = await api.find<{ status: string }>(
      `/repos/${input.repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(tag)}`,
    );
    return comparison?.status === "ahead" || comparison?.status === "identical";
  };

  const numbers: number[] = [];
  for (const { number } of candidates) {
    // A link may name an issue or a deleted pull request: GitHub's 404 just skips it.
    const pull = await api.find<GithubPull>(`/repos/${input.repo}/pulls/${number}`);
    if (!pull?.merged_at || !pull.merge_commit_sha) {
      continue;
    }
    const ships =
      (await contains(input.tag, pull.merge_commit_sha)) &&
      !(previous && (await contains(previous.tag_name, pull.merge_commit_sha)));
    if (ships) {
      numbers.push(number!);
    }
  }
  const posts = await linkedPosts(project.id, input.repo, numbers);
  for (const post of posts) {
    await prisma.postLink.upsert({
      where: { postId_url: { postId: post.id, url: input.url } },
      update: { title: input.name },
      create: {
        projectId: project.id,
        postId: post.id,
        kind: "RELEASE",
        repo: input.repo,
        tag: input.tag,
        url: input.url,
        title: input.name,
        source: "REFERENCE",
      },
    });
  }
  const completed = await moveTo("COMPLETED", project, posts);
  log.info(`${input.repo} ${input.tag}: ships ${numbers.length} linked pull request(s), ${completed} post(s) completed`);
  return { completed };
}
