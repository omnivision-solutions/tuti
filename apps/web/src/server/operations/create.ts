import { isEmptyDoc } from "@tuti/content";
import { Prisma, prisma } from "@tuti/db";
import { enqueue, seenAs } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { namedProjectUser } from "@/server/project-users";

import { attachMedia, displayDoc, MediaGoneError, readContent } from "../content";
import { emitEvent } from "../events";
import { type Actor, defineOperation, OperationError } from "./define";
import { actorPostViewer, fromApiVisibility, seesBoard, VISIBILITIES } from "../post-visibility";
import { findVisiblePost, postNumber, postSummarySelect, projectPortal, summary } from "./read";
import { onTeam, signedInAsReader } from "../session";

/** A comment that isn't (or is no longer) on the post: replied to or liked. */
export const noSuchComment = () => new OperationError(404, "not_found", "There's no such comment on this post");

/**
 * A write that names a comment (a reply's parent, a like's comment) and failed its foreign key (P2003) because the comment
 * was deleted meanwhile (its author's account deleted, Autopilot's comment undone): "There's no such comment". Any other
 * failure is thrown as it is.
 */
export async function orNoSuchComment<T>(commentId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003" &&
      !(await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } }))
    ) {
      throw noSuchComment();
    }
    throw error;
  }
}

/** Longest plain text a post or comment may have (rich content is capped by size too). */
export const MAX_TEXT_LENGTH = 5000;

const content = {
  /** Plain text; ignored when `content` is sent. */
  body: z.string().max(MAX_TEXT_LENGTH * 2).optional(),
  /** A document (@tuti/content), checked against the post or comment profile. */
  content: z.unknown().optional(),
};

/** Someone from the project's app, matched by their id there (as with SSO). */
export const author = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().trim().min(1).max(100).optional(),
    email: z.email().max(320).optional(),
  })
  .optional();

/**
 * Who writes it: the signed-in person; for an API key, someone from the project's
 * app when `author` is given (created on first sight; see namedProjectUser), otherwise the key's creator.
 */
export async function authorId(context: { actor: Actor; projectId: string }, input: z.infer<typeof author>) {
  if (context.actor.kind === "user") {
    if (input) {
      throw new OperationError(403, "forbidden", "Only API keys can write on someone's behalf");
    }
    return context.actor.userId;
  }
  if (!input) {
    return context.actor.createdById;
  }
  return namedProjectUser(context.actor, context.projectId, input);
}

/** Saves content; an upload claimed by the cleanup meanwhile rolls the save back (see `attachMedia`). */
export async function saving<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if (error instanceof MediaGoneError) {
      throw new OperationError(409, "media_gone", error.message);
    }
    throw error;
  }
}

export const MAX_POST_TITLE = 120;

export const createPost = defineOperation({
  name: "posts.create",
  summary:
    "Create a post, as the key's creator or on behalf of someone from your app (`author`); who sees it (`visibility`: public, private for its author and the team, team for the team only) is its board's choice unless the team says",
  method: "POST",
  path: "/posts",
  scope: "write",
  access: "anyone",
  input: z.object({
    board: z.string().min(1),
    title: z.string().trim().min(3, "Title is too short").max(MAX_POST_TITLE),
    ...content,
    author,
    /** Who sees it besides the team; its board's choice when not sent. The team's only. */
    visibility: z.enum(VISIBILITIES).optional(),
  }),
  example: {
    board: "feature-requests",
    title: "Dark mode",
    body: "The dashboard is too bright at night.",
    author: { id: "user-42", name: "Sam", email: "sam@example.com" },
  },
  run: async (context, input) => {
    const { projectId } = context;
    const [board, viewer] = await Promise.all([
      prisma.board.findFirst({ where: { projectId, slug: input.board }, select: { id: true, postVisibility: true, off: true } }),
      actorPostViewer(context.actor, projectId),
    ]);
    // A Team only board, or one turned off, is the team's: nobody else sees it or posts there (post-visibility.ts).
    if (!board || !seesBoard(viewer, board)) {
      throw new OperationError(404, "not_found", "Board not found");
    }
    if (input.visibility && !viewer.team) {
      throw new OperationError(403, "forbidden", "Only your team can choose who sees a post");
    }
    const text = await readContent("post", input, { projectId, maxLength: MAX_TEXT_LENGTH });
    if (text.error !== undefined) {
      throw new OperationError(400, "invalid_content", text.error);
    }
    const userId = await authorId(context, input.author);
    // Before anything is written: a lookup failing after the post is saved would fail a request that did save it.
    const portal = await projectPortal(projectId);

    const post = await saving(() =>
      prisma.$transaction(async (tx) => {
      // Locks the project row, so concurrent posts get distinct numbers.
      const { postCount: number } = await tx.project.update({
        where: { id: projectId },
        data: { postCount: { increment: 1 } },
        select: { postCount: true },
      });
      // Authors automatically upvote their own post.
      const created = await tx.post.create({
        data: {
          projectId,
          boardId: board.id,
          authorId: userId,
          number,
          title: input.title,
          body: text.text,
          content: text.doc,
          visibility: input.visibility ? fromApiVisibility(input.visibility) : board.postVisibility,
          voteCount: 1,
          votes: { create: { userId, projectId } },
        },
        select: { ...postSummarySelect, id: true },
      });
      await attachMedia(tx, projectId, text.mediaIds);
      return created;
      }),
    );

    // Background work must never block or fail the request.
    try {
      await enqueue("postCreated", { projectId, postId: post.id });
    } catch (error) {
      log.error("Enqueueing the post-created job failed", { error, postId: post.id });
    }
    const created = summary(post, portal);
    await emitEvent(projectId, "post.created", created);
    return created;
  },
});

export const createComment = defineOperation({
  name: "comments.create",
  summary:
    "Comment on a post, as the key's creator (shown as the team) or on behalf of someone from your app; or, as the team, leave an internal note (`internal: true`): only the team sees it, never on the portal, in emails or webhooks. The team's reply can be emailed to the post's voters too (`emailVoters: true`). `replyTo`: a comment's id, to reply to it (replies are one level deep: a reply to a reply goes under the comment it replies to)",
  method: "POST",
  path: "/posts/{number}/comments",
  scope: "write",
  access: "anyone",
  input: z.object({
    number: postNumber,
    ...content,
    author,
    /** An internal note: only the team sees it (never on the portal, in emails or webhooks; over the API, only to the team). The team's only. */
    internal: z.boolean().optional(),
    /** The team's reply emailed to the post's voters too (those who may still read it and haven't unsubscribed). The team's only; not with a note. */
    emailVoters: z.boolean().optional(),
    /** The id of the post's comment it replies to (comments.list); a reply's id puts it under that reply's comment. Not with a note. */
    replyTo: z.string().min(1).max(64).optional(),
  }),
  example: { body: "Thanks! This is planned for next month." },
  run: async (context, input) => {
    const { projectId } = context;
    const post = await findVisiblePost(context.actor, projectId, input.number);
    if (post.duplicateOf) {
      throw new OperationError(409, "merged", "This post was merged into another one; comment there instead");
    }
    const text = await readContent("comment", input, { projectId, maxLength: MAX_TEXT_LENGTH });
    if (text.error !== undefined) {
      throw new OperationError(400, "invalid_content", text.error);
    }
    // An image alone will do.
    if (isEmptyDoc(text.doc)) {
      throw new OperationError(400, "invalid_content", "Write something first");
    }
    if (input.internal && input.emailVoters) {
      throw new OperationError(400, "invalid_input", "An internal note isn't emailed to anyone");
    }
    if (input.internal && input.replyTo) {
      throw new OperationError(400, "invalid_input", "An internal note can't reply to a comment");
    }
    // Refused before anything is written (a project user made for `author`); read again under the post's lock below.
    if (input.replyTo && !(await prisma.comment.count({ where: { id: input.replyTo, postId: post.id } }))) {
      throw noSuchComment();
    }
    // Notes, and replies emailed to voters, are the team's own: written by a team member, or the team's key as
    // itself (keys are the team's, as actorReader has them).
    const teamOnly = input.internal ? "Only your team can write internal notes" : input.emailVoters ? "Only your team can email a post's voters" : null;
    if (teamOnly && input.author) {
      throw new OperationError(403, "forbidden", teamOnly);
    }
    const userId = await authorId(context, input.author);
    if (teamOnly && context.actor.kind !== "apiKey" && !(await onTeam(projectId, userId))) {
      throw new OperationError(403, "forbidden", teamOnly);
    }
    const portal = await projectPortal(projectId);
    if (input.internal) {
      // Whether its author is on the team now, as comments.list says it (a key's creator may have left): read
      // before saving, so a failure here can't follow a saved note (a retry would save it twice).
      const member = await onTeam(projectId, userId);
      // A note: its own table, so nothing that reads comments shows it; no count, no webhook.
      const note = await saving(() =>
        prisma.$transaction(async (tx) => {
          const created = await tx.postNote.create({
            data: { postId: post.id, authorId: userId, body: text.text, content: text.doc },
            select: { id: true, body: true, content: true, createdAt: true, author: { select: { name: true } } },
          });
          await attachMedia(tx, projectId, text.mediaIds);
          return created;
        }),
      );
      return { id: note.id, author: { name: note.author.name, team: member }, body: note.body, content: displayDoc(note), createdAt: note.createdAt.toISOString(), internal: true as const };
    }

    // Written with a portal's session: a reader's, never shown as the team's, whoever wrote it.
    const asReader = await signedInAsReader(userId);
    const write = () =>
      prisma.$transaction(async (tx) => {
        // The post locked first, as every writer of its comments takes it (votes.set, comments.like, a merge, Autopilot's
        // Undo): a reply's foreign key holds its parent comment, so taking the post after it could deadlock with an Undo
        // deleting that comment. A merge meanwhile moved its comments: comment there instead.
        const [locked] = await tx.$queryRaw<{ duplicateOfId: string | null }[]>`
          SELECT "duplicateOfId" FROM post WHERE id = ${post.id} FOR NO KEY UPDATE`;
        if (locked?.duplicateOfId) {
          throw new OperationError(409, "merged", "This post was merged into another one; comment there instead");
        }
        // One level deep: a reply to a reply goes under the comment that one replies to.
        const parent = input.replyTo
          ? await tx.comment.findFirst({ where: { id: input.replyTo, postId: post.id }, select: { id: true, parentId: true } })
          : null;
        if (input.replyTo && !parent) {
          throw noSuchComment();
        }
        const parentId = parent ? (parent.parentId ?? parent.id) : null;
        const created = await tx.comment.create({
          // Emailed to voters: due from now (reply-emailed sends it; the cron brings back one that didn't).
          // Not for sample content (Home's "Add sample content"): no webhook, and its voters aren't emailed.
          data: { projectId, postId: post.id, authorId: userId, body: text.text, content: text.doc, asReader, parentId, ...(input.emailVoters && !post.sample && seenAs(post) !== "TEAM" && { votersEmailDueAt: new Date() }) },
          select: { id: true, body: true, content: true, createdAt: true, parentId: true, author: { select: { name: true } } },
        });
        await tx.post.update({ where: { id: post.id }, data: { commentCount: { increment: 1 } } });
        await attachMedia(tx, projectId, text.mediaIds);
        return created;
      });
    // Its parent deleted by a writer that doesn't lock the post (its author's account): "There's no such comment".
    const comment = await saving(() => (input.replyTo ? orNoSuchComment(input.replyTo, write) : write()));
    const team = await onTeam(projectId, userId);
    const created = {
      id: comment.id,
      author: { name: comment.author.name, team },
      body: comment.body,
      content: displayDoc(comment),
      createdAt: comment.createdAt.toISOString(),
      replyTo: comment.parentId,
    };
    const { url, number, title } = summary(post, portal);
    if (post.sample) {
      return created;
    }
    await emitEvent(projectId, "comment.created", { post: { number, title, url }, comment: created });
    if (input.emailVoters) {
      try {
        await enqueue("replyEmailed", { commentId: comment.id });
      } catch (error) {
        // Still due: reply-emails-resubmit queues it again.
        log.warn("Couldn't queue a reply's emails to voters", { commentId: comment.id, error });
      }
    }
    return created;
  },
});
