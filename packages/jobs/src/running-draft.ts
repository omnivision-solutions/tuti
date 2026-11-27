import { toPlainText } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { log as serverLog } from "@tuti/shared";

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
/** A merged pull request as GitHub gives it (MergedPull), what the team's decision on it keeps. */
type Merged = PullRequest & { repoId: number; author: string; mergedAt: string };

/**
 * The page the project knows a pull request by: the one its code change or the team's decision on it has, or else
 * `url`. A repository's pages move when it's renamed, and the changelog's rows keep the one they were written with.
 */
export async function knownUrl(tx: Prisma.TransactionClient, projectId: string, pr: { repoId: number; number: number; url: string }): Promise<string> {
  const key = { projectId, repoId: pr.repoId, number: pr.number };
  const [change, decision] = await Promise.all([
    tx.codeChange.findUnique({ where: { projectId_repoId_number: key }, select: { url: true } }),
    tx.changelogDecision.findUnique({ where: { projectId_repoId_number: key }, select: { url: true } }),
  ]);
  return change?.url ?? decision?.url ?? pr.url;
}

/** The team's decision on a pull request (taken out of a draft, or picked in), kept with the page the changelog has it under. */
const keepDecision = (tx: Prisma.TransactionClient, projectId: string, pr: Merged, takenOut: boolean) => {
  const kept = { repo: pr.repo, url: pr.url, title: pr.title, author: pr.author, mergedAt: new Date(pr.mergedAt), takenOut };
  return tx.changelogDecision.upsert({ where: { projectId_repoId_number: { projectId, repoId: pr.repoId, number: pr.number } }, create: { projectId, repoId: pr.repoId, number: pr.number, ...kept }, update: kept });
};

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
 * lock the gate takes to remove it, so a redelivery racing the gate can't put it back. Never one the team took out of a
 * draft (ChangelogDecision, found by `pr.repoId` where it's given), unless they're the ones adding it (`picked`:
 * changelog.addPullRequests, with what GitHub says of it), which their decision then says instead, so the gate leaves it
 * in. By the page the project knows it by (as knownUrl), so a renamed repository's isn't added twice. Returns whether it
 * was added.
 */
export async function addToRunningDraft(
  projectId: string,
  given: PullRequest & { repoId?: number },
  gate?: { repoId: number },
  { picked }: { picked?: Merged } = {},
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // One at a time (see lockProject): the draft found here is still the running one when it's written.
    if (!(await lockProject(tx, projectId))) {
      return false;
    }
    const repoId = given.repoId ?? gate?.repoId;
    const key = repoId === undefined ? null : { projectId, repoId, number: given.number };
    const [change, decision] = key
      ? await Promise.all([
          tx.codeChange.findUnique({ where: { projectId_repoId_number: key }, select: { state: true, url: true } }),
          tx.changelogDecision.findUnique({ where: { projectId_repoId_number: key }, select: { takenOut: true, url: true } }),
        ])
      : [null, await tx.changelogDecision.findFirst({ where: { projectId, url: given.url }, select: { takenOut: true, url: true } })];
    const pr = { ...given, url: change?.url ?? decision?.url ?? given.url };
    if (picked) {
      // Theirs from here on, whether or not an entry already has it.
      await keepDecision(tx, projectId, { ...picked, url: pr.url }, false);
    } else if (decision?.takenOut || (gate && change?.state === "NOTHING_TO_DO" && decision?.takenOut !== false)) {
      return false;
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

const bulletText = (pr: Pick<PullRequest, "repo" | "number" | "title">) => `${pr.title} (${pr.repo}#${pr.number})`;

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

/**
 * A release closes the running draft: named after the release (unless the team named it), and the next merge starts a new one.
 * `releasedAt` is when GitHub published the release (jobs may run out of order): the newest release's draft is the one to write.
 */
export async function closeRunningDraft(projectId: string, releaseName: string, releasedAt = new Date()): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockProject(tx, projectId))) {
      return null;
    }
    const draft = await tx.changelogEntry.findFirst({ where: { projectId, collecting: true }, select: { id: true, number: true } });
    if (!draft) {
      return null;
    }
    await tx.changelogEntry.update({ where: { id: draft.id }, data: { collecting: false, releasedAt } });
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

/** Whether a list item is one paragraph of nothing but `text` (no image or anything else added to it). */
const saysOnly = (item: Item, text: string) =>
  textOf(item) === text && item.content?.length === 1 && (((item.content[0] as Item).content ?? []) as Item[]).every((node) => node.type === "text");

/** The document without the pull request's bullet, or only those that are just `text` (and without a list it leaves empty). */
function withoutBullet(doc: Doc, url: string, text?: string): Doc {
  const content = (doc.content ?? [])
    .map((block) =>
      block.type === "bulletList"
        ? { ...block, content: (block.content as Item[] | undefined)?.filter((item) => !isBullet(item, url) || (text !== undefined && !saysOnly(item, text))) }
        : block,
    )
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
    // The team added it themselves (read under the lock their adding takes): the gate's word doesn't take it out.
    const change = await tx.codeChange.findFirst({ where: { projectId, url }, select: { repoId: true, number: true } });
    if (change && (await tx.changelogDecision.count({ where: { projectId, repoId: change.repoId, number: change.number, takenOut: false } })) > 0) {
      return false;
    }
    const known = await tx.changelogEntryPullRequest.findFirst({ where: { url, entry: { projectId, collecting: true } }, select: { entryId: true } });
    if (!known) {
      return false;
    }
    await takeOut(tx, known.entryId, url);
    return true;
  });
}

/** The pull request's row and its bullet (while its text is still a bullet linking to it), out of the entry. */
async function takeOut(tx: Prisma.TransactionClient, entryId: string, url: string) {
  await tx.changelogEntryPullRequest.delete({ where: { entryId_url: { entryId, url } } });
  // The entry's row too: an edit in the changelog (which doesn't take the project's lock) waits, or is seen here.
  const [entry] = await tx.$queryRaw<{ content: Prisma.JsonValue }[]>`SELECT content FROM changelog_entry WHERE id = ${entryId} FOR UPDATE`;
  const doc = withoutBullet((entry?.content as Doc | null | undefined) ?? { type: "doc", content: [] }, url);
  await tx.changelogEntry.update({ where: { id: entryId }, data: { content: doc as Prisma.InputJsonValue, body: toPlainText(doc as Parameters<typeof toPlainText>[0]) } });
}

/**
 * The team takes a pull request out of a draft (it ships in a later release, or isn't for readers): its row and its
 * bullet go, from the running draft or one a release closed; never from a published entry. Their decision is kept
 * (`pr`: what GitHub says of it, null where that's not known), so no analysis still to run, retry or redelivery puts it
 * back, and the line Autopilot wrote for it stays recorded. In no entry any more, it can be added to the next one
 * (changelog.addPullRequests).
 */
export async function removePullRequest(projectId: string, entryId: string, url: string, pr: Merged | null): Promise<"removed" | "published" | "missing"> {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const known = await tx.changelogEntryPullRequest.findFirst({ where: { url, entryId, entry: { projectId } }, select: { entry: { select: { publishedAt: true } } } });
    if (!known) {
      return "missing";
    }
    if (known.entry.publishedAt) {
      return "published";
    }
    await takeOut(tx, entryId, url);
    if (pr) {
      await keepDecision(tx, projectId, { ...pr, url }, true);
    }
    return "removed";
  });
}

const textOf = (node: Item & { text?: string }): string => node.text ?? ((node.content ?? []) as Item[]).map(textOf).join("");

/** Nodes that hold nothing of their own: blank unless what's in them isn't. */
const CONTAINERS = new Set(["listItem", "paragraph", "heading", "blockquote", "bulletList", "orderedList"]);

/** Whether a node holds nothing at all: blank text and line breaks, in paragraphs and lists, and no image or anything else. */
const blank = (node: Item & { text?: string }): boolean =>
  node.type === "text" ? !node.text?.trim() : node.type === "hardBreak" || (CONTAINERS.has(node.type) && ((node.content ?? []) as Item[]).every(blank));

/**
 * Whether an entry with pull requests isn't written yet: its text is only their titles, as the running draft wrote
 * them ("Add a dark theme (acme/app#301)", or the bare title a code change's line falls back to), or `lines` (the
 * lines Autopilot wrote into their bullets, writeChangelogLine), or nothing (failed analyses took them out). Nobody
 * wrote it, by hand or with AI.
 */
export function onlyPullRequestTitles(content: unknown, pullRequests: Pick<PullRequest, "repo" | "number" | "title">[], lines: string[] = []): boolean {
  const titles = new Set([...pullRequests.flatMap((pr) => [bulletText(pr), pr.title]), ...lines]);
  // Not a blank block of any kind (the editor saves an empty paragraph after a list), nor a bullet whose text was deleted.
  const blocks = ((content as Doc | null)?.content ?? []).filter((block) => !blank(block as Item));
  return (
    pullRequests.length > 0 &&
    blocks.every((block) => block.type === "bulletList" && ((block.content ?? []) as Item[]).every((item) => blank(item) || titles.has(textOf(item))))
  );
}

/**
 * The lines Autopilot wrote into these pull requests' bullets (writeChangelogLine, or one the team approved as it was):
 * only those in the draft (applied: not one still waiting, dismissed or undone, whose words the team may have typed
 * themselves), and not one the team reworded before approving it, which is theirs.
 */
export async function autopilotLines(projectId: string, urls: string[]): Promise<string[]> {
  const actions = await prisma.codeChangeAction.findMany({
    where: { kind: "CHANGELOG_LINE", status: "APPLIED", codeChange: { projectId, url: { in: urls } } },
    select: { payload: true },
  });
  return actions.flatMap(({ payload }) => {
    const { line, edited } = (payload ?? {}) as { line?: unknown; edited?: unknown };
    return typeof line === "string" && edited !== true ? [line] : [];
  });
}

/**
 * A merged pull request whose analysis failed leaves the running draft's text while its bullet still says the
 * pull request's title (an edited line stays): a title isn't release notes. It stays in the entry, for Draft
 * with AI. Only while its code change has never had its changelog line written: an analysis that works then writes
 * it (writeChangelogLine, once per pull request). Returns whether it left.
 */
export async function dropFailedLine(projectId: string, url: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    if ((await tx.codeChangeAction.count({ where: { kind: "CHANGELOG_LINE", codeChange: { projectId, url } } })) > 0) {
      return false;
    }
    const known = await tx.changelogEntryPullRequest.findFirst({ where: { url, entry: { projectId, collecting: true } }, select: { entryId: true, repo: true, number: true, title: true } });
    if (!known) {
      return false;
    }
    // The entry's row too: an edit in the changelog (which doesn't take the project's lock) waits, or is seen here.
    const [entry] = await tx.$queryRaw<{ content: Prisma.JsonValue }[]>`SELECT content FROM changelog_entry WHERE id = ${known.entryId} FOR UPDATE`;
    const current = (entry?.content as Doc | null | undefined) ?? { type: "doc", content: [] };
    // Only bullets still saying its title: a line the team wrote for it (linking to it too) stays.
    const doc = withoutBullet(current, url, bulletText(known));
    if (JSON.stringify(doc) === JSON.stringify(current)) {
      return false;
    }
    await tx.changelogEntry.update({ where: { id: known.entryId }, data: { content: doc as Prisma.InputJsonValue, body: toPlainText(doc as Parameters<typeof toPlainText>[0]) } });
    return true;
  });
}

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
 * bullet said before (read under the lock that writes it) or what writing it added. `unlessPublished`: null, writing
 * nothing, where the entry is published (checked under that lock, so a release published meanwhile isn't changed).
 */
export async function setChangelogLine(
  projectId: string,
  pr: PullRequest,
  line: string,
  { unlessPublished = false } = {},
): Promise<{ number: number; previous: string | null; added: "entry" | "bullet" | null } | null> {
  const found = await prisma.changelogEntryPullRequest.findFirst({ where: { url: pr.url, entry: { projectId } }, select: { entryId: true } });
  if (!found) {
    await addToRunningDraft(projectId, pr);
  }
  let published: string | null = null;
  const result = await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const known = await tx.changelogEntryPullRequest.findFirstOrThrow({ where: { url: pr.url, entry: { projectId } }, select: { entryId: true } });
    // The entry's row too: an edit in the changelog (which doesn't take the project's lock) waits, or is seen here.
    const [entry] = await tx.$queryRaw<{ number: number; content: Prisma.JsonValue; publishedAt: Date | null }[]>`SELECT number, content, "publishedAt" FROM changelog_entry WHERE id = ${known.entryId} FOR UPDATE`;
    if (unlessPublished && entry?.publishedAt) {
      return null;
    }
    const current = (entry?.content as Doc | null | undefined) ?? { type: "doc", content: [] };
    // What the bullet said as it's rewritten (for Undo), or what writing it adds: the pull request with it, or the bullet.
    const bullet = (current.content ?? []).flatMap((block) => (block.type === "bulletList" ? ((block.content as Item[] | undefined) ?? []) : [])).find((item) => isBullet(item, pr.url));
    // The team may have rewritten the bullet without its link: then the line goes at the end of the draft's list.
    const doc = withLine(current, pr.url, line) ?? withPullRequest(current, { ...pr, title: line }, line);
    await tx.changelogEntry.update({ where: { id: known.entryId }, data: { content: doc as Prisma.InputJsonValue, body: toPlainText(doc as Parameters<typeof toPlainText>[0]) } });
    if (entry?.publishedAt) {
      published = known.entryId;
    }
    return {
      number: entry!.number,
      previous: found && bullet ? textOf(bullet) : null,
      added: !found ? ("entry" as const) : bullet ? null : ("bullet" as const),
    };
  });
  if (published) {
    // A published entry's text changed (an Autopilot line approved into it): its languages kept up to date follow
    // (docs/plan.md L16), never failing the line, which is written.
    const entryId = published;
    // Imported here: at the top it would close an import cycle (code-change-docs → article-layers → … → running-draft →
    // article-translation → … → verify → code-change-docs) that has verify read code-change-docs' prompts before they're defined.
    const { queueChangelogTranslations } = await import("./article-translation");
    await queueChangelogTranslations(entryId).catch((error: unknown) => serverLog.error("Couldn't queue a changelog entry's translations", { entryId, error }));
  }
  return result;
}
