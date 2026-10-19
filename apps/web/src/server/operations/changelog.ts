import { type ChangelogTag, type PostStatus, prisma } from "@tuti/db";
import {
  enqueue,
  lockProject,
  postSummary,
  postSummarySelect,
  queueDeliveries,
  recordEvent,
  RUNNING_DRAFT_TITLE,
  toApiStatus,
} from "@tuti/jobs";
import { aiEnabled, complete, log } from "@tuti/shared";
import { z } from "zod";

import { portalUrl } from "@/lib/hosts";
import { postPath } from "@/lib/post-urls";

import { attachMedia, displayDoc, readContent } from "../content";
import { readReleaseNotes, releaseNotesPrompt } from "../release-notes";
import { saving } from "./create";
import { type Actor, defineOperation, OperationError } from "./define";
import { postNumber, projectSlug } from "./read";

/** Changelog entries (Phase 8): drafts the team writes, published on the portal's /changelog. */

export const MAX_ENTRY_LENGTH = 20_000;
const TAGS = ["new", "improved", "fixed", "breaking"] as const;
const toTag = (tag: (typeof TAGS)[number]) => tag.toUpperCase() as ChangelogTag;

const entryNumber = z.coerce.number().int().positive();
const fields = {
  title: z.string().trim().min(3, "Title is too short").max(120),
  /** Plain text; ignored when `content` is sent. */
  body: z.string().max(MAX_ENTRY_LENGTH).optional(),
  /** Rich content (the editor's JSON, "changelog" profile). */
  content: z.unknown().optional(),
  tags: z.array(z.enum(TAGS)).max(TAGS.length),
  /** The posts this entry completes, by number. */
  posts: z.array(postNumber).max(50),
};

const entrySelect = {
  id: true,
  number: true,
  title: true,
  body: true,
  content: true,
  tags: true,
  publishedAt: true,
  announced: true,
  collecting: true,
  createdAt: true,
  updatedAt: true,
  posts: { select: { post: { select: { id: true, number: true, title: true, status: true } } } },
  pullRequests: { orderBy: { createdAt: "asc" }, select: { repo: true, number: true, url: true, title: true } },
} as const;

type EntryRow = NonNullable<Awaited<ReturnType<typeof findEntry>>>;

function entryView(entry: EntryRow, slug: string) {
  const portal = portalUrl(slug);
  return {
    number: entry.number,
    title: entry.title,
    status: entry.publishedAt ? ("published" as const) : ("draft" as const),
    publishedAt: entry.publishedAt?.toISOString() ?? null,
    /** Published with an announcement (shown as new in the widget), not quietly. */
    announced: entry.announced,
    /** The running draft: merged pull requests are being added to it. */
    collecting: entry.collecting,
    tags: entry.tags.map((tag) => tag.toLowerCase()),
    body: entry.body,
    content: displayDoc(entry),
    posts: entry.posts.map(({ post }) => ({ number: post.number, title: post.title, url: `${portal}${postPath(post)}` })),
    /** Merged pull requests the running draft collected. */
    pullRequests: entry.pullRequests,
    url: `${portal}/changelog/${entry.number}`,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** API keys are the team's; people are when they're on the project's team. Only the team sees drafts. */
async function isTeam(actor: Actor, projectId: string): Promise<boolean> {
  if (actor.kind === "apiKey") {
    return true;
  }
  return (await prisma.teamMember.count({ where: { projectId, userId: actor.userId } })) > 0;
}

const findEntry = (projectId: string, number: number) =>
  prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: entrySelect });

async function teamEntry(projectId: string, number: number) {
  const entry = await findEntry(projectId, number);
  if (!entry) {
    throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
  }
  return entry;
}

/** The ids of these posts in the project (not merged away); a 400 naming any that aren't there. */
async function postIds(projectId: string, numbers: number[]): Promise<string[]> {
  const unique = [...new Set(numbers)];
  const posts = await prisma.post.findMany({
    where: { projectId, number: { in: unique }, duplicateOfId: null },
    select: { id: true, number: true },
  });
  const missing = unique.filter((n) => !posts.some((p) => p.number === n));
  if (missing.length > 0) {
    throw new OperationError(400, "invalid_input", `There's no post ${missing.map((n) => `#${n}`).join(", ")}`);
  }
  return posts.map((p) => p.id);
}

async function entryText(input: { body?: string; content?: unknown }, projectId: string) {
  const text = await readContent("changelog", input, { projectId, maxLength: MAX_ENTRY_LENGTH });
  if (text.error !== undefined) {
    throw new OperationError(400, "invalid_content", text.error);
  }
  return text;
}

export const listChangelog = defineOperation({
  name: "changelog.list",
  summary: "List changelog entries, newest first: published ones, or the team's drafts",
  method: "GET",
  path: "/changelog",
  scope: "read",
  access: "anyone",
  input: z.object({
    status: z.enum(["published", "draft"]).default("published"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  example: { status: "published", limit: 10 },
  run: async ({ actor, projectId }, input) => {
    if (input.status === "draft" && !(await isTeam(actor, projectId))) {
      throw new OperationError(403, "forbidden", "Only the project's team sees drafts");
    }
    const published = input.status === "published";
    const entries = await prisma.changelogEntry.findMany({
      where: { projectId, publishedAt: published ? { not: null } : null },
      orderBy: published ? [{ publishedAt: "desc" }, { number: "desc" }] : [{ updatedAt: "desc" }, { number: "desc" }],
      skip: input.cursor,
      take: input.limit + 1,
      select: entrySelect,
    });
    const slug = await projectSlug(projectId);
    return {
      entries: entries.slice(0, input.limit).map((entry) => entryView(entry, slug)),
      nextCursor: entries.length > input.limit ? String(input.cursor + input.limit) : null,
    };
  },
});

export const getChangelogEntry = defineOperation({
  name: "changelog.get",
  summary: "Get a changelog entry by its number (drafts only for the team)",
  method: "GET",
  path: "/changelog/{number}",
  scope: "read",
  access: "anyone",
  input: z.object({ number: entryNumber }),
  run: async ({ actor, projectId }, { number }) => {
    const entry = await findEntry(projectId, number);
    // A draft is as good as missing to everyone but the team.
    if (!entry || (!entry.publishedAt && !(await isTeam(actor, projectId)))) {
      throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
    }
    return entryView(entry, await projectSlug(projectId));
  },
});

export const createChangelogEntry = defineOperation({
  name: "changelog.create",
  summary: "Write a changelog entry (a draft until it's published) and pick the posts it completes",
  method: "POST",
  path: "/changelog",
  scope: "write",
  access: "team",
  input: z.object({ ...fields, tags: fields.tags.default([]), posts: fields.posts.default([]) }),
  example: { title: "Dark mode", body: "Switch themes from your profile menu.", tags: ["new"], posts: [12] },
  run: async ({ actor, projectId }, input) => {
    const text = await entryText(input, projectId);
    const posts = await postIds(projectId, input.posts);
    const entry = await saving(() =>
      prisma.$transaction(async (tx) => {
        // Locks the project row, so concurrent entries get distinct numbers.
        const { changelogCount: number } = await tx.project.update({
          where: { id: projectId },
          data: { changelogCount: { increment: 1 } },
          select: { changelogCount: true },
        });
        const created = await tx.changelogEntry.create({
          data: {
            projectId,
            number,
            title: input.title,
            body: text.text,
            content: text.doc,
            tags: input.tags.map(toTag),
            createdById: actor.kind === "user" ? actor.userId : actor.createdById,
            posts: { create: posts.map((postId) => ({ postId })) },
          },
          select: entrySelect,
        });
        await attachMedia(tx, projectId, text.mediaIds);
        return created;
      }),
    );
    return entryView(entry, await projectSlug(projectId));
  },
});

export const updateChangelogEntry = defineOperation({
  name: "changelog.update",
  summary: "Change a changelog entry: its title, text, tags or the posts it completes (posts replace the list; only while it's a draft)",
  method: "PATCH",
  path: "/changelog/{number}",
  scope: "write",
  access: "team",
  input: z.object({
    number: entryNumber,
    title: fields.title.optional(),
    body: fields.body,
    content: fields.content,
    tags: fields.tags.optional(),
    posts: fields.posts.optional(),
  }),
  example: { tags: ["new", "improved"] },
  run: async ({ projectId }, input) => {
    const entry = await teamEntry(projectId, input.number);
    if (entry.publishedAt && input.posts) {
      // Publishing completed its posts; a post added now wouldn't be. Same list is fine.
      const now = new Set(entry.posts.map(({ post }) => post.number));
      const wanted = new Set(input.posts);
      if (now.size !== wanted.size || [...wanted].some((n) => !now.has(n))) {
        throw new OperationError(409, "published", "Unpublish the entry to change the posts it completes");
      }
    }
    const text = input.body !== undefined || input.content !== undefined ? await entryText(input, projectId) : null;
    const posts = input.posts && (await postIds(projectId, input.posts));
    const updated = await saving(() =>
      prisma.$transaction(async (tx) => {
        if (posts) {
          await tx.changelogEntryPost.deleteMany({ where: { entryId: entry.id } });
        }
        const saved = await tx.changelogEntry.update({
          where: { id: entry.id },
          data: {
            ...(input.title !== undefined && { title: input.title }),
            ...(text && { body: text.text, content: text.doc }),
            ...(input.tags && { tags: input.tags.map(toTag) }),
            ...(posts && { posts: { create: posts.map((postId) => ({ postId })) } }),
          },
          select: entrySelect,
        });
        if (text) {
          await attachMedia(tx, projectId, text.mediaIds);
        }
        return saved;
      }),
    );
    return entryView(updated, await projectSlug(projectId));
  },
});

export const draftChangelogEntry = defineOperation({
  name: "changelog.draft",
  summary:
    "Replace a draft entry's text with release notes the AI writes from its pull requests and the posts it completes (and name it, if it still has the running draft's title)",
  method: "POST",
  path: "/changelog/{number}/draft",
  scope: "write",
  access: "team",
  input: z.object({ number: entryNumber }),
  run: async ({ projectId }, { number }) => {
    if (!aiEnabled()) {
      throw new OperationError(503, "ai_unavailable", "AI isn't set up on this server");
    }
    const entry = await teamEntry(projectId, number);
    if (entry.publishedAt) {
      throw new OperationError(409, "published", "Unpublish the entry to draft its text with AI");
    }
    const slug = await projectSlug(projectId);
    const { posts } = entryView(entry, slug);
    if (posts.length === 0 && entry.pullRequests.length === 0 && entry.body.trim() === "") {
      throw new OperationError(400, "nothing_to_draft", "Pick the posts it completes or write a few notes first");
    }
    const style = await changelogStyle(projectId);
    let reply: string;
    try {
      reply = await complete(releaseNotesPrompt({ posts, pullRequests: entry.pullRequests, text: entry.body, style }));
    } catch (error) {
      log.warn("AI changelog draft failed", { projectId, number, error });
      throw new OperationError(502, "ai_failed", "The AI couldn't write a draft. Try again in a moment.");
    }
    const draft = readReleaseNotes(reply, new Set(posts.map((post) => post.url)));
    // Checked like anything the team saves.
    const text = draft && (await readContent("changelog", { content: draft.doc }, { projectId, maxLength: MAX_ENTRY_LENGTH }));
    if (!draft || !text || text.error !== undefined) {
      log.warn("AI changelog draft unusable", { projectId, number, reply: reply.slice(0, 500) });
      throw new OperationError(502, "ai_failed", "The AI's draft couldn't be used. Try again.");
    }
    // Only if nothing changed while the model wrote (a save, a merged pull request, publishing, another draft).
    const { count } = await prisma.changelogEntry.updateMany({
      where: { id: entry.id, updatedAt: entry.updatedAt, publishedAt: null },
      data: {
        body: text.text,
        content: text.doc,
        ...(entry.title === RUNNING_DRAFT_TITLE && draft.title && { title: draft.title }),
      },
    });
    if (count === 0) {
      throw new OperationError(409, "changed", "The entry changed while the AI was writing. Try again.");
    }
    return entryView(await teamEntry(projectId, number), slug);
  },
});

export const MAX_TONE_LENGTH = 1000;
export const MAX_STYLE_EXAMPLES = 3;

/** The team's tone notes and example entries (the ones still published, in the order picked). */
async function changelogStyle(projectId: string) {
  const { changelogTone, changelogExampleIds } = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { changelogTone: true, changelogExampleIds: true },
  });
  const entries = await prisma.changelogEntry.findMany({
    where: { projectId, id: { in: changelogExampleIds }, publishedAt: { not: null } },
    select: { id: true, number: true, title: true, body: true },
  });
  return { tone: changelogTone, examples: changelogExampleIds.flatMap((id) => entries.filter((entry) => entry.id === id)) };
}

const styleView = ({ tone, examples }: Awaited<ReturnType<typeof changelogStyle>>) => ({
  tone,
  examples: examples.map(({ number, title }) => ({ number, title })),
});

export const getChangelogStyle = defineOperation({
  name: "changelogStyle.get",
  summary: "Get the changelog's writing style: the tone notes and example entries AI drafts follow",
  method: "GET",
  path: "/changelog-style",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => styleView(await changelogStyle(projectId)),
});

export const updateChangelogStyle = defineOperation({
  name: "changelogStyle.update",
  summary: `Set the changelog's writing style for AI drafts: tone notes, and up to ${MAX_STYLE_EXAMPLES} published entries (by number) as examples (replaces the list)`,
  method: "PATCH",
  path: "/changelog-style",
  scope: "write",
  access: "team",
  input: z.object({
    tone: z.string().trim().max(MAX_TONE_LENGTH, "Keep the tone notes under 1,000 characters").optional(),
    examples: z.array(entryNumber).max(MAX_STYLE_EXAMPLES, `Pick up to ${MAX_STYLE_EXAMPLES} examples`).optional(),
  }),
  example: { tone: "Friendly, short sentences, no jargon. Address the reader as you.", examples: [3] },
  run: async ({ projectId }, input) => {
    let exampleIds: string[] | undefined;
    if (input.examples) {
      const numbers = [...new Set(input.examples)];
      const entries = await prisma.changelogEntry.findMany({
        where: { projectId, number: { in: numbers }, publishedAt: { not: null } },
        select: { id: true, number: true },
      });
      const missing = numbers.filter((n) => !entries.some((entry) => entry.number === n));
      if (missing.length > 0) {
        throw new OperationError(400, "invalid_input", `There's no published entry ${missing.map((n) => `#${n}`).join(", ")}`);
      }
      exampleIds = numbers.map((n) => entries.find((entry) => entry.number === n)!.id);
    }
    await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.tone !== undefined && { changelogTone: input.tone }),
        ...(exampleIds && { changelogExampleIds: exampleIds }),
      },
    });
    return styleView(await changelogStyle(projectId));
  },
});

export const publishChangelogEntry = defineOperation({
  name: "changelog.publish",
  summary:
    "Publish a changelog entry on the portal; the posts it completes become Completed. Announced (the default) it shows as new in the widget; `announce: false` publishes it quietly",
  method: "POST",
  path: "/changelog/{number}/publish",
  scope: "write",
  access: "team",
  input: z.object({ number: entryNumber, announce: z.boolean().default(true) }),
  example: { announce: true },
  run: async ({ projectId }, { number, announce }) => {
    const entry = await teamEntry(projectId, number);
    const slug = await projectSlug(projectId);
    // One transaction: published, its posts completed (and due for their shipped
    // emails), and the webhook deliveries saved. Sending happens after it commits.
    const shipped = await prisma.$transaction(async (tx) => {
      // After any merge being added to this (running) draft, and before the next (see lockProject).
      await lockProject(tx, projectId);
      // Only the first publish counts (a repeated call changes nothing).
      const { count } = await tx.changelogEntry.updateMany({
        where: { id: entry.id, publishedAt: null },
        // Published by hand, it stops collecting: the next merge starts a new draft.
        data: { publishedAt: new Date(), collecting: false, announced: announce },
      });
      if (count === 0) {
        return null;
      }
      const deliveries: string[] = [];
      const completed: string[] = [];
      // Its posts as they are now: each locked and read in this transaction, so a status
      // the team changed a moment ago is the one that counts.
      // Locked in id order, so two entries sharing posts can't deadlock publishing at once.
      const linked = await tx.changelogEntryPost.findMany({
        where: { entryId: entry.id },
        orderBy: { postId: "asc" },
        select: { postId: true },
      });
      for (const { postId } of linked) {
        const [current] = await tx.$queryRaw<{ status: PostStatus }[]>`SELECT status FROM post WHERE id = ${postId} FOR UPDATE`;
        if (!current || current.status === "COMPLETED" || current.status === "CLOSED") {
          continue;
        }
        await tx.post.update({ where: { id: postId }, data: { status: "COMPLETED", shippedEmailsDueAt: new Date() } });
        const updated = await tx.post.findUniqueOrThrow({ where: { id: postId }, select: postSummarySelect });
        deliveries.push(
          ...(await recordEvent(tx, projectId, "post.status_changed", {
            post: postSummary(updated, slug),
            previousStatus: toApiStatus(current.status),
          })),
        );
        completed.push(postId);
      }
      const published = await tx.changelogEntry.findUniqueOrThrow({ where: { id: entry.id }, select: entrySelect });
      deliveries.push(...(await recordEvent(tx, projectId, "changelog.published", entryView(published, slug))));
      return { deliveries, completed };
    });
    if (shipped) {
      // Anything not queued now is picked up by the webhook-resubmit and shipped-emails-resubmit jobs.
      await queueDeliveries(shipped.deliveries);
      for (const postId of shipped.completed) {
        try {
          await enqueue("postShipped", { postId });
        } catch (error) {
          log.warn("Couldn't queue a post's shipped emails", { postId, error });
        }
      }
    }
    return entryView(await teamEntry(projectId, number), slug);
  },
});

export const unpublishChangelogEntry = defineOperation({
  name: "changelog.unpublish",
  summary: "Take a changelog entry off the portal (back to a draft); posts keep their status",
  method: "POST",
  path: "/changelog/{number}/unpublish",
  scope: "write",
  access: "team",
  input: z.object({ number: entryNumber }),
  run: async ({ projectId }, { number }) => {
    const entry = await teamEntry(projectId, number);
    await prisma.changelogEntry.update({ where: { id: entry.id }, data: { publishedAt: null } });
    return entryView(await teamEntry(projectId, number), await projectSlug(projectId));
  },
});

export const deleteChangelogEntry = defineOperation({
  name: "changelog.delete",
  summary: "Delete a changelog entry",
  method: "DELETE",
  path: "/changelog/{number}",
  scope: "write",
  access: "team",
  input: z.object({ number: entryNumber }),
  run: async ({ projectId }, { number }) => {
    const entry = await teamEntry(projectId, number);
    await prisma.changelogEntry.delete({ where: { id: entry.id } });
    return { deleted: number };
  },
});
