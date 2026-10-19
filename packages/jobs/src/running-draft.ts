import { type Prisma, prisma } from "@tuti/db";

/** A content document (@tuti/content's JSON), kept loose here so the worker needn't load the editor's schema. */
type Doc = { type: "doc"; content?: { type: string; content?: unknown[] }[] };

/**
 * The changelog's running draft (Phase 8): every merged pull request is added to
 * the project's one collecting draft, made when the first one merges. A release
 * (or the team publishing it) closes it, and the next merge starts a new one.
 */

/** The title a running draft starts with; a release renames it unless the team has. */
export const RUNNING_DRAFT_TITLE = "Next release";

/** Labels for work people don't need to hear about. ponytail: fixed list; per-project settings later. */
const SKIP_LABELS = new Set(["chore", "internal", "deps", "dependencies"]);

export const skipsChangelog = (labels: string[]) => labels.some((label) => SKIP_LABELS.has(label.toLowerCase()));

type PullRequest = { repo: string; number: number; url: string; title: string };

/**
 * Locks a project's row for the rest of the transaction. Everything that changes
 * which draft is running (adding a merged PR, a release closing it, publishing it)
 * takes this first, so they happen one after another. False if there's no such project.
 */
export async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM project WHERE id = ${projectId} FOR UPDATE`;
  return rows.length === 1;
}

/** Adds a merged pull request to the running draft (once, however often GitHub delivers it). Returns whether it was added. */
export async function addToRunningDraft(projectId: string, pr: PullRequest): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // One at a time (see lockProject): the draft found here is still the running one when it's written.
    if (!(await lockProject(tx, projectId))) {
      return false;
    }
    const entry = (await tx.changelogEntry.findFirst({ where: { projectId, collecting: true }, select: { id: true } })) ?? (await newDraft(tx, projectId));
    const { count } = await tx.changelogEntryPullRequest.createMany({
      data: [{ entryId: entry.id, url: pr.url, repo: pr.repo, number: pr.number, title: pr.title }],
      skipDuplicates: true,
    });
    if (count === 0) {
      return false;
    }
    const current = await tx.changelogEntry.findUniqueOrThrow({ where: { id: entry.id }, select: { content: true, body: true } });
    const doc = withPullRequest((current.content as Doc | null) ?? { type: "doc", content: [] }, pr);
    // The plain text gets the bullet's line, as @tuti/content's toPlainText would write it.
    const body = [current.body, bulletText(pr)].filter(Boolean).join("\n");
    await tx.changelogEntry.update({ where: { id: entry.id }, data: { content: doc as Prisma.InputJsonValue, body } });
    // The posts it references (linked by the pull request job) are what this entry completes.
    const posts = await tx.postLink.findMany({ where: { projectId, url: pr.url, post: { duplicateOfId: null } }, select: { postId: true } });
    await tx.changelogEntryPost.createMany({ data: posts.map(({ postId }) => ({ entryId: entry.id, postId })), skipDuplicates: true });
    return true;
  });
}

async function newDraft(tx: Prisma.TransactionClient, projectId: string) {
  const { changelogCount: number } = await tx.project.update({
    where: { id: projectId },
    data: { changelogCount: { increment: 1 } },
    select: { changelogCount: true },
  });
  return tx.changelogEntry.create({
    data: { projectId, number, title: RUNNING_DRAFT_TITLE, collecting: true },
    select: { id: true },
  });
}

const bulletText = (pr: PullRequest) => `${pr.title} (${pr.repo}#${pr.number})`;

/** The draft with one more bullet, "<title> (repo#number)" linking to the pull request, in the list at its end. */
function withPullRequest(doc: Doc, pr: PullRequest): Doc {
  const item = {
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: bulletText(pr), marks: [{ type: "link", attrs: { href: pr.url } }] }],
      },
    ],
  };
  const content = [...(doc.content ?? [])];
  const last = content.at(-1);
  if (last?.type === "bulletList") {
    content[content.length - 1] = { ...last, content: [...(last.content ?? []), item] };
  } else {
    content.push({ type: "bulletList", content: [item] });
  }
  return { ...doc, content };
}

/** A release closes the running draft: named after the release (unless the team named it), and the next merge starts a new one. */
export async function closeRunningDraft(projectId: string, releaseName: string): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockProject(tx, projectId))) {
      return null;
    }
    const draft = await tx.changelogEntry.findFirst({ where: { projectId, collecting: true }, select: { id: true, number: true } });
    if (!draft) {
      return null;
    }
    await tx.changelogEntry.update({ where: { id: draft.id }, data: { collecting: false } });
    // Only a title nobody changed (checked as it's written).
    await tx.changelogEntry.updateMany({ where: { id: draft.id, title: RUNNING_DRAFT_TITLE }, data: { title: releaseName.slice(0, 120) } });
    return draft.number;
  });
}
