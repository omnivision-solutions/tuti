import { toPlainText } from "@tuti/content";
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

/**
 * Adds a merged pull request to the running draft (once per project, however often GitHub delivers it).
 * With `gate` (code changes on), not one whose code change has nothing to do: checked under the same
 * lock the gate takes to remove it, so a redelivery racing the gate can't put it back. Returns whether it was added.
 */
export async function addToRunningDraft(projectId: string, pr: PullRequest, gate?: { repoId: number }): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // One at a time (see lockProject): the draft found here is still the running one when it's written.
    if (!(await lockProject(tx, projectId))) {
      return false;
    }
    if (gate) {
      const change = await tx.codeChange.findUnique({
        where: { projectId_repoId_number: { projectId, repoId: gate.repoId, number: pr.number } },
        select: { state: true },
      });
      if (change?.state === "NOTHING_TO_DO") {
        return false;
      }
    }
    // Already in an entry (this draft or an earlier, closed one): a redelivery adds it nowhere.
    const known = await tx.changelogEntryPullRequest.findFirst({ where: { url: pr.url, entry: { projectId } }, select: { entryId: true } });
    if (known) {
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

/** The draft with one more bullet, "<title> (repo#number)" (or `text`) linking to the pull request, in the list at its end. */
function withPullRequest(doc: Doc, pr: PullRequest, text = bulletText(pr)): Doc {
  const item = {
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text, marks: [{ type: "link", attrs: { href: pr.url } }] }],
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
    await tx.changelogEntry.update({ where: { id: draft.id }, data: { collecting: false, releasedAt: new Date() } });
    // Only a title nobody changed (checked as it's written).
    await tx.changelogEntry.updateMany({ where: { id: draft.id, title: RUNNING_DRAFT_TITLE }, data: { title: releaseName.slice(0, 120) } });
    return draft.number;
  });
}

type Item = { type: string; content?: unknown[]; marks?: { type: string; attrs?: { href?: unknown } }[] };

const linksTo = (node: Item, url: string): boolean =>
  (node.marks ?? []).some((mark) => mark.type === "link" && mark.attrs?.href === url) || ((node.content ?? []) as Item[]).some((child) => linksTo(child, url));

/** Whether a list item is the pull request's bullet: its text links to the pull request. */
const isBullet = (item: Item, url: string) => item.type === "listItem" && linksTo(item, url);

/** The document without the pull request's bullet (and without a list it leaves empty). */
function withoutBullet(doc: Doc, url: string): Doc {
  const content = (doc.content ?? [])
    .map((block) => (block.type === "bulletList" ? { ...block, content: (block.content as Item[] | undefined)?.filter((item) => !isBullet(item, url)) } : block))
    .filter((block) => block.type !== "bulletList" || (block.content?.length ?? 0) > 0);
  return { ...doc, content };
}

/** The document with the pull request's bullet saying `line` (still linking to it); null if it has no such bullet. */
function withLine(doc: Doc, url: string, line: string): Doc | null {
  let found = false;
  const content = (doc.content ?? []).map((block) =>
    block.type !== "bulletList"
      ? block
      : {
          ...block,
          content: (block.content as Item[] | undefined)?.map((item) => {
            if (!isBullet(item, url)) {
              return item;
            }
            found = true;
            return { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: line, marks: [{ type: "link", attrs: { href: url } }] }] }] };
          }),
        },
  );
  return found ? { ...doc, content } : null;
}

/**
 * A merged pull request users don't see (its code change has nothing to do) leaves the running
 * draft it's in, while that draft still collects. Returns whether it was there.
 */
export async function removeFromRunningDraft(projectId: string, url: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockProject(tx, projectId))) {
      return false;
    }
    const known = await tx.changelogEntryPullRequest.findFirst({ where: { url, entry: { projectId, collecting: true } }, select: { entryId: true } });
    if (!known) {
      return false;
    }
    await tx.changelogEntryPullRequest.delete({ where: { entryId_url: { entryId: known.entryId, url } } });
    const entry = await tx.changelogEntry.findUniqueOrThrow({ where: { id: known.entryId }, select: { content: true } });
    const doc = withoutBullet((entry.content as Doc | null) ?? { type: "doc", content: [] }, url);
    await tx.changelogEntry.update({ where: { id: known.entryId }, data: { content: doc as Prisma.InputJsonValue, body: toPlainText(doc as Parameters<typeof toPlainText>[0]) } });
    return true;
  });
}

const textOf = (node: Item & { text?: string }): string => node.text ?? ((node.content ?? []) as Item[]).map(textOf).join("");

/**
 * The pull request's bullet as its entry has it now (its text, and whether the entry is published), or
 * null if no entry has it. For putting a changelog line back (Autopilot's Undo).
 */
export async function changelogLineOf(projectId: string, url: string): Promise<{ text: string | null; published: boolean } | null> {
  const known = await prisma.changelogEntryPullRequest.findFirst({ where: { url, entry: { projectId } }, select: { entry: { select: { content: true, publishedAt: true } } } });
  if (!known) {
    return null;
  }
  const doc = (known.entry.content as Doc | null) ?? { type: "doc", content: [] };
  const bullet = (doc.content ?? []).flatMap((block) => (block.type === "bulletList" ? ((block.content as Item[] | undefined) ?? []) : [])).find((item) => isBullet(item, url));
  return { text: bullet ? textOf(bullet) : null, published: known.entry.publishedAt !== null };
}

/**
 * Autopilot's Undo of a changelog line: the pull request's bullet goes back to `previous`, or out again
 * (`added`), with the entry's record of the pull request when applying added that too ("entry"). Only
 * in a draft, and only while the bullet still says what was approved (`applied`; null: whatever it
 * says, for an apply that failed): "published" or "edited" otherwise, changing nothing. No entry has the pull request any more: nothing to put back.
 */
export async function undoChangelogLine(
  projectId: string,
  url: string,
  { applied, previous, added }: { applied: string | null; previous: string; added: "entry" | "bullet" | null },
): Promise<"done" | "published" | "edited"> {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const known = await tx.changelogEntryPullRequest.findFirst({ where: { url, entry: { projectId } }, select: { entryId: true, entry: { select: { content: true, publishedAt: true } } } });
    if (!known) {
      return "done";
    }
    if (known.entry.publishedAt) {
      return "published";
    }
    // The entry's row too, read again: an edit in the changelog (which doesn't take the project's lock) waits, or is seen.
    const [entry] = await tx.$queryRaw<{ content: Prisma.JsonValue }[]>`SELECT content FROM changelog_entry WHERE id = ${known.entryId} FOR UPDATE`;
    const current = (entry?.content as Doc | null | undefined) ?? { type: "doc", content: [] };
    const bullet = (current.content ?? []).flatMap((block) => (block.type === "bulletList" ? ((block.content as Item[] | undefined) ?? []) : [])).find((item) => isBullet(item, url));
    if (bullet && applied !== null && textOf(bullet) !== applied) {
      return "edited";
    }
    if (added === "entry") {
      await tx.changelogEntryPullRequest.delete({ where: { entryId_url: { entryId: known.entryId, url } } });
    }
    const doc = added ? withoutBullet(current, url) : (withLine(current, url, previous) ?? current);
    await tx.changelogEntry.update({ where: { id: known.entryId }, data: { content: doc as Prisma.InputJsonValue, body: toPlainText(doc as Parameters<typeof toPlainText>[0]) } });
    return "done";
  });
}

/**
 * A code change's changelog line: the pull request's bullet, in whichever entry has it, says `line`
 * instead of the pull request's title. Not in any (say, it had nothing to do until "Analyse anyway"):
 * it's added to the running draft with that line. Returns the entry's number, and for Undo, what the
 * bullet said before (read under the lock that writes it) or what writing it added.
 */
export async function setChangelogLine(
  projectId: string,
  pr: PullRequest,
  line: string,
): Promise<{ number: number; previous: string | null; added: "entry" | "bullet" | null }> {
  const found = await prisma.changelogEntryPullRequest.findFirst({ where: { url: pr.url, entry: { projectId } }, select: { entryId: true } });
  if (!found) {
    await addToRunningDraft(projectId, pr);
  }
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const known = await tx.changelogEntryPullRequest.findFirstOrThrow({ where: { url: pr.url, entry: { projectId } }, select: { entryId: true } });
    // The entry's row too: an edit in the changelog (which doesn't take the project's lock) waits, or is seen here.
    const [entry] = await tx.$queryRaw<{ number: number; content: Prisma.JsonValue }[]>`SELECT number, content FROM changelog_entry WHERE id = ${known.entryId} FOR UPDATE`;
    const current = (entry?.content as Doc | null | undefined) ?? { type: "doc", content: [] };
    // What the bullet said as it's rewritten (for Undo), or what writing it adds: the pull request with it, or the bullet.
    const bullet = (current.content ?? []).flatMap((block) => (block.type === "bulletList" ? ((block.content as Item[] | undefined) ?? []) : [])).find((item) => isBullet(item, pr.url));
    // The team may have rewritten the bullet without its link: then the line goes at the end of the draft's list.
    const doc = withLine(current, pr.url, line) ?? withPullRequest(current, { ...pr, title: line }, line);
    await tx.changelogEntry.update({ where: { id: known.entryId }, data: { content: doc as Prisma.InputJsonValue, body: toPlainText(doc as Parameters<typeof toPlainText>[0]) } });
    return {
      number: entry!.number,
      previous: found && bullet ? textOf(bullet) : null,
      added: !found ? ("entry" as const) : bullet ? null : ("bullet" as const),
    };
  });
}
