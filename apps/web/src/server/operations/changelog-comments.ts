import { isEmptyDoc } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { z } from "zod";

import { claimsOf, groupClaims } from "@/lib/reader-groups";

import { attachMedia, displayDoc, readContent } from "../content";
import { writesAsReader } from "../session";
import { isTeam, mayReadEntry } from "./changelog";
import { authorId, describedAuthor, MAX_TEXT_LENGTH, saving } from "./create";
import { type Actor, defineOperation, OperationError } from "./define";
import { commentShape } from "./read";

/**
 * Comments on published changelog entries: readers write them (the comment profile, as a post's), their authors edit or
 * delete them, and the team deletes any (moderation, as the team does with what's posted on its portal).
 */

const entryNumber = z.coerce.number().int().positive().describe("The entry's number in the project").meta({ examples: [7] });
const commentId = z.string().min(1).max(64).describe("The comment's id (changelogComments.list)").meta({ examples: ["cm3k9a1bc0002ab12cd34ef56"] });
const text = {
  body: z.string().max(MAX_TEXT_LENGTH * 2).optional().describe("Its text, as plain text; ignored when `content` is sent").meta({ examples: ["Love it, thanks!"] }),
  content: z.unknown().optional().describe("Its text as a rich document (Tuti's content format, as the editor writes it), instead of `body`"),
};

const entryCommentOutput = z
  .object({
    ...commentShape,
    id: z.string().describe("The comment's id: changelogComments.update and changelogComments.delete take it").meta({ examples: ["cm3k9a1bc0002ab12cd34ef56"] }),
    editedAt: z.string().nullable().describe("When its author last edited it (ISO 8601); null if never").meta({ examples: [null] }),
  })
  .meta({ id: "ChangelogComment", description: "A comment on a published changelog entry" });

const select = {
  id: true,
  body: true,
  content: true,
  asReader: true,
  createdAt: true,
  editedAt: true,
  author: { select: { id: true, name: true } },
} as const;
type Row = { id: string; body: string; content: unknown; asReader: boolean; createdAt: Date; editedAt: Date | null; author: { id: string; name: string } };

const view = (row: Row, team: Set<string>) => ({
  id: row.id,
  // A team member's comment written with a portal's session or by the widget is a reader's (writesAsReader).
  author: { name: row.author.name, team: team.has(row.author.id) && !row.asReader },
  body: row.body,
  content: displayDoc(row),
  createdAt: row.createdAt.toISOString(),
  editedAt: row.editedAt?.toISOString() ?? null,
});

const teamIds = async (projectId: string) =>
  new Set((await prisma.teamMember.findMany({ where: { projectId }, select: { userId: true } })).map((m) => m.userId));

/** The entry, as changelog.get finds it: a draft is as good as missing to everyone but the team, and one for some groups to everyone outside them. */
async function visibleEntry(actor: Actor, projectId: string, number: number) {
  const entry = await prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: { id: true, publishedAt: true, emailOnly: true, groups: groupClaims } });
  if (!entry || (!entry.publishedAt && !(await isTeam(actor, projectId))) || !(await mayReadEntry(actor, projectId, entry))) {
    throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
  }
  return entry;
}

/** Only published entries take comments, or edits to them (as reactions). */
function published(entry: { publishedAt: Date | null }) {
  if (!entry.publishedAt) {
    throw new OperationError(409, "draft", "Only published entries take comments");
  }
}

/**
 * In a comment's write: the entry's row locked (FOR SHARE: unpublishing and deleting it update its row, so they wait for
 * this write, or this one sees what they did) and still published. Gone meanwhile: its 404, as `visibleEntry` says it.
 */
async function stillPublished(tx: Prisma.TransactionClient, entryId: string, number: number) {
  const [row] = await tx.$queryRaw<{ publishedAt: Date | null }[]>`SELECT "publishedAt" FROM changelog_entry WHERE id = ${entryId} FOR SHARE`;
  if (!row) {
    throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
  }
  published(row);
}

async function readText(projectId: string, input: { body?: string; content?: unknown }) {
  const read = await readContent("comment", input, { projectId, maxLength: MAX_TEXT_LENGTH });
  if (read.error !== undefined) {
    throw new OperationError(400, "invalid_content", read.error);
  }
  // An image alone will do.
  if (isEmptyDoc(read.doc)) {
    throw new OperationError(400, "invalid_content", "Write something first");
  }
  return read;
}

const noSuchComment = () => new OperationError(404, "not_found", "There's no such comment on this entry");

const findComment = async (entryId: string, id: string) => {
  const comment = await prisma.changelogComment.findFirst({ where: { id, entryId }, select: { ...select, authorId: true } });
  if (!comment) {
    throw noSuchComment();
  }
  return comment;
};

export const listChangelogComments = defineOperation({
  name: "changelogComments.list",
  title: "List an entry's comments",
  summary: "List a changelog entry's comments, oldest first. Drafts only for the team: to anyone else a draft isn't there (404)",
  method: "GET",
  path: "/changelog/{number}/comments",
  scope: "read",
  access: "anyone",
  input: z.object({ number: entryNumber }),
  output: z.object({ comments: z.array(entryCommentOutput).describe("The comments, oldest first") }).describe("The entry's comments"),
  run: async ({ actor, projectId }, { number }) => {
    const entry = await visibleEntry(actor, projectId, number);
    const [comments, team] = await Promise.all([
      prisma.changelogComment.findMany({ where: { entryId: entry.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select }),
      teamIds(projectId),
    ]);
    return { comments: comments.map((comment) => view(comment, team)) };
  },
});

export const createChangelogComment = defineOperation({
  name: "changelogComments.create",
  title: "Comment on an entry",
  summary: "Comment on a published changelog entry, as the key's creator or on behalf of someone from your app. A draft takes none (409)",
  method: "POST",
  path: "/changelog/{number}/comments",
  scope: "write",
  access: "anyone",
  errors: [409],
  input: z.object({ number: entryNumber, ...text, author: describedAuthor }),
  output: entryCommentOutput.describe("The comment written"),
  example: { body: "Love it, thanks!", author: { id: "user-42", name: "Sam", email: "sam@example.com" } },
  run: async (context, input) => {
    const { projectId } = context;
    const entry = await visibleEntry(context.actor, projectId, input.number);
    published(entry);
    const read = await readText(projectId, input);
    const userId = await authorId(context, input.author);
    // Written by the widget's person or with a portal's session: a reader's, never shown as the team's, whoever wrote it.
    const asReader = await writesAsReader(context.actor, userId);
    const comment = await saving(() =>
      prisma.$transaction(async (tx) => {
        await stillPublished(tx, entry.id, input.number);
        const created = await tx.changelogComment.create({
          data: { entryId: entry.id, authorId: userId, body: read.text, content: read.doc, asReader },
          select,
        });
        await attachMedia(tx, projectId, read.mediaIds);
        return created;
      }),
    );
    return view(comment, await teamIds(projectId));
  },
});

export const updateChangelogComment = defineOperation({
  name: "changelogComments.update",
  title: "Edit a comment on an entry",
  summary: "Edit a comment on a published changelog entry: only its author (the key's creator, or `author`) may",
  method: "PATCH",
  path: "/changelog/{number}/comments/{id}",
  scope: "write",
  access: "anyone",
  errors: [409],
  input: z.object({ number: entryNumber, id: commentId, ...text, author: describedAuthor }),
  output: entryCommentOutput.describe("The comment, edited"),
  example: { body: "Love it, thanks! Works great on my phone too.", author: { id: "user-42" } },
  run: async (context, input) => {
    const { projectId } = context;
    const entry = await visibleEntry(context.actor, projectId, input.number);
    published(entry);
    const comment = await findComment(entry.id, input.id);
    if (comment.authorId !== (await authorId(context, input.author))) {
      throw new OperationError(403, "forbidden", "Only its author can edit a comment");
    }
    const read = await readText(projectId, input);
    const edited = await saving(() =>
      prisma.$transaction(async (tx) => {
        await stillPublished(tx, entry.id, input.number);
        // Deleted meanwhile (its author's other tab, the team): it's gone, not an error.
        const { count } = await tx.changelogComment.updateMany({ where: { id: comment.id, entryId: entry.id }, data: { body: read.text, content: read.doc, editedAt: new Date() } });
        if (count === 0) {
          throw noSuchComment();
        }
        await attachMedia(tx, projectId, read.mediaIds);
        return tx.changelogComment.findUniqueOrThrow({ where: { id: comment.id }, select });
      }),
    );
    return view(edited, await teamIds(projectId));
  },
});

export const deleteChangelogComment = defineOperation({
  name: "changelogComments.delete",
  title: "Delete a comment on an entry",
  summary: "Delete a comment on a changelog entry, for good: its author's own, or any for the team (a key is the team's)",
  method: "DELETE",
  path: "/changelog/{number}/comments/{id}",
  scope: "write",
  access: "anyone",
  input: z.object({ number: entryNumber, id: commentId }),
  output: z.object({ deleted: z.string().describe("The deleted comment's id").meta({ examples: ["cm3k9a1bc0002ab12cd34ef56"] }) }).describe("What was deleted"),
  run: async ({ actor, projectId }, input) => {
    const entry = await visibleEntry(actor, projectId, input.number);
    const comment = await findComment(entry.id, input.id);
    const mine = actor.kind === "user" && comment.authorId === actor.userId;
    // The team moderates: a key, or a member in the app (on the portal they're a reader: onTeam).
    if (!mine && !(await isTeam(actor, projectId))) {
      throw new OperationError(403, "forbidden", "Only its author or the team can delete a comment");
    }
    // Its images are freed by release-media once nothing uses them.
    await prisma.changelogComment.deleteMany({ where: { id: comment.id } });
    return { deleted: comment.id };
  },
});
