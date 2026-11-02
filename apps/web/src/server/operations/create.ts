import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { upsertProjectUser } from "@/server/project-users";

import { attachMedia, displayDoc, MediaGoneError, readContent } from "../content";
import { emitEvent } from "../events";
import { type Actor, defineOperation, OperationError } from "./define";
import { findPost, postNumber, postSummarySelect, projectPortal, summary } from "./read";

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
 * app when `author` is given (created on first sight), otherwise the key's creator.
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
  return upsertProjectUser(context.projectId, input.id, { name: input.name, email: input.email });
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
  summary: "Create a post, as the key's creator or on behalf of someone from your app (`author`)",
  method: "POST",
  path: "/posts",
  scope: "write",
  access: "anyone",
  input: z.object({
    board: z.string().min(1),
    title: z.string().trim().min(3, "Title is too short").max(MAX_POST_TITLE),
    ...content,
    author,
  }),
  example: {
    board: "feature-requests",
    title: "Dark mode",
    body: "The dashboard is too bright at night.",
    author: { id: "user-42", name: "Sam", email: "sam@example.com" },
  },
  run: async (context, input) => {
    const { projectId } = context;
    const board = await prisma.board.findFirst({ where: { projectId, slug: input.board }, select: { id: true } });
    if (!board) {
      throw new OperationError(404, "not_found", "Board not found");
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
    "Comment on a post, as the key's creator (shown as the team) or on behalf of someone from your app; or, as the team, leave an internal note (`internal: true`): only the team sees it, never on the portal, in emails or webhooks. The team's reply can be emailed to the post's voters too (`emailVoters: true`)",
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
  }),
  example: { body: "Thanks! This is planned for next month." },
  run: async (context, input) => {
    const { projectId } = context;
    const post = await findPost(projectId, input.number);
    if (post.duplicateOf) {
      throw new OperationError(409, "merged", "This post was merged into another one; comment there instead");
    }
    const text = await readContent("comment", input, { projectId, maxLength: MAX_TEXT_LENGTH });
    if (text.error !== undefined) {
      throw new OperationError(400, "invalid_content", text.error);
    }
    if (text.text === "") {
      throw new OperationError(400, "invalid_content", "Write something first");
    }
    if (input.internal && input.emailVoters) {
      throw new OperationError(400, "invalid_input", "An internal note isn't emailed to anyone");
    }
    // Notes, and replies emailed to voters, are the team's own: written by a team member, or the team's key as
    // itself (keys are the team's, as actorReader has them).
    const teamOnly = input.internal ? "Only your team can write internal notes" : input.emailVoters ? "Only your team can email a post's voters" : null;
    if (teamOnly && input.author) {
      throw new OperationError(403, "forbidden", teamOnly);
    }
    const userId = await authorId(context, input.author);
    if (teamOnly && context.actor.kind !== "apiKey" && !(await prisma.teamMember.findFirst({ where: { projectId, userId }, select: { id: true } }))) {
      throw new OperationError(403, "forbidden", teamOnly);
    }
    const portal = await projectPortal(projectId);
    if (input.internal) {
      // Whether its author is on the team now, as comments.list says it (a key's creator may have left): read
      // before saving, so a failure here can't follow a saved note (a retry would save it twice).
      const member = await prisma.teamMember.findFirst({ where: { projectId, userId }, select: { id: true } });
      // A note: its own table, so nothing that reads comments shows it; no count, no webhook.
      const note = await saving(() =>
        prisma.postNote.create({
          data: { postId: post.id, authorId: userId, body: text.text, content: text.doc },
          select: { id: true, body: true, content: true, createdAt: true, author: { select: { name: true } } },
        }),
      );
      return { id: note.id, author: { name: note.author.name, team: !!member }, body: note.body, content: displayDoc(note), createdAt: note.createdAt.toISOString(), internal: true as const };
    }

    const comment = await saving(() =>
      prisma.$transaction(async (tx) => {
        const created = await tx.comment.create({
          // Emailed to voters: due from now (reply-emailed sends it; the cron brings back one that didn't).
          // Not for sample content (Home's "Add sample content"): no webhook, and its voters aren't emailed.
          data: { projectId, postId: post.id, authorId: userId, body: text.text, content: text.doc, ...(input.emailVoters && !post.sample && { votersEmailDueAt: new Date() }) },
          select: { id: true, body: true, content: true, createdAt: true, author: { select: { name: true } } },
        });
        await tx.post.update({ where: { id: post.id }, data: { commentCount: { increment: 1 } } });
        // Comments can't have images yet (see the comment profile); this keeps them safe from cleanup once they can.
        await attachMedia(tx, projectId, text.mediaIds);
        return created;
      }),
    );
    const team = await prisma.teamMember.findFirst({ where: { projectId, userId }, select: { id: true } });
    const created = {
      id: comment.id,
      author: { name: comment.author.name, team: !!team },
      body: comment.body,
      content: displayDoc(comment),
      createdAt: comment.createdAt.toISOString(),
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
