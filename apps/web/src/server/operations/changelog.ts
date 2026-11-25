import { type Doc, isVideo, toMarkdown, toPlainText, videoPageUrl } from "@tuti/content";
import { type ChangelogReactionKind, type ChangelogTag, type PostStatus, type PostVisibility, type Prisma, prisma } from "@tuti/db";
import {
  addToRunningDraft,
  analysisOn,
  claimCodeChange,
  creditBalance,
  enqueue,
  knownUrl,
  lockProject,
  markdownToContent,
  mergedPullRequests,
  mergedPullRequestsByRef,
  type MergedPull,
  type PortalAddress,
  postSummary,
  postSummarySelect,
  queueClaimed,
  queueDeliveries,
  recordEvent,
  removePullRequest,
  RUNNING_DRAFT_TITLE,
  SEEN_AS_SQL,
  setChangelogLine,
  storeImage,
  toApiStatus,
  uploadImage,
} from "@tuti/jobs";
import { mediaLimit, mediaStorage } from "@tuti/shared/storage";
import { aiEnabled, complete, creditsEnabled, creditsPerUsageDollar, listModels, log, MAX_ENTRY_LENGTH } from "@tuti/shared";
import { z } from "zod";

import { portalAddress } from "@/server/custom-domains";
import { costPerUse } from "@/lib/model-tiers";
import { postPath } from "@/lib/post-urls";
import { REACTIONS, type ReactionCounts } from "@/lib/reactions";
import { claimsOf, groupClaims, MAX_READER_GROUPS, readerGroup, visibleEntry } from "@/lib/reader-groups";

import { reactionCounts } from "../changelog-queries";
import { attachMedia, displayDoc, MEDIA_GONE, readContent } from "../content";
import { automaticDesign, COVER_DESIGNS, type CoverDesign, coverContent, coverDesigns, CoverPictureUnread, drawCover, MAX_COVER_HEADLINE } from "../cover-card";
import { lastingImage, lastingMediaUrls } from "../media-urls";
import {
  blocksToNotes,
  droppedFacts,
  factsIn,
  readReleaseNotes,
  droppedMarkers,
  markersIn,
  releaseNotesPrompt,
  REWRITE_MODES,
  rewritePrompt,
  sectionRange,
} from "../release-notes";
import { aiModels } from "./ai-models";
import { branding } from "./branding";
import { imageOutput } from "./widget";
import { author, authorId, saving } from "./create";
import { aiOrRefuse } from "./credits";
import { type Actor, defineOperation, OperationError } from "./define";
import { postNumber, projectPortal, projectSlug } from "./read";
import { onTeam } from "../session";
import { actorReader } from "../portal-access";
import { groupLinks } from "./docs";
import { requirePlan } from "./plan";

/** Changelog entries (Phase 8): drafts the team writes, published on the portal's /changelog. */

const TAGS = ["new", "improved", "fixed", "breaking"] as const;
const toTag = (tag: (typeof TAGS)[number]) => tag.toUpperCase() as ChangelogTag;

const doc = z.record(z.string(), z.unknown());
const exampleDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Switch themes from your profile menu." }] }] };

const entryNumber = z.coerce.number().int().positive().describe("The entry's number in the project").meta({ examples: [7] });
const fields = {
  title: z.string().trim().min(3, "Title is too short").max(120).describe("Its title, 3 to 120 characters").meta({ examples: ["Dark mode"] }),
  body: z
    .string()
    .max(MAX_ENTRY_LENGTH)
    .optional()
    .describe("Its text, as plain text; ignored when `content` or `markdown` is sent")
    .meta({ examples: ["Switch themes from your profile menu."] }),
  content: z
    .unknown()
    .optional()
    .describe("Its text as rich content: the editor's JSON (a `doc`, the changelog profile)")
    .meta({ examples: [exampleDoc] }),
  markdown: z
    .string()
    // Its markup counts too: the text it makes is held to the limit below.
    .max(MAX_ENTRY_LENGTH * 2)
    .optional()
    .describe(
      "Its text, as Markdown (headings, lists, links, images, code); the images it links to are copied into your project, and those that can't be (unreachable, not an image, too large) are left out. Ignored when `content` is sent",
    )
    .meta({ examples: ["## Dark mode\n\nSwitch themes from your **profile menu**."] }),
  tags: z
    .array(z.enum(TAGS))
    .max(TAGS.length)
    .describe("What kind of change it is: new, improved, fixed or breaking")
    .meta({ examples: [["new"]] }),
  posts: z.array(postNumber).max(50).describe("The posts it completes, by number: pick up to 50").meta({ examples: [[12]] }),
  groups: z
    .array(readerGroup)
    .max(MAX_READER_GROUPS, `Up to ${MAX_READER_GROUPS} groups`)
    .transform((groups) => [...new Set(groups)])
    .describe(
      `The reader groups it's for, by key (see groups.list), up to ${MAX_READER_GROUPS}: only their readers (and the team) see it on the portal, in the widget and in the API, it's in no feed, sitemap or Markdown copy, and it's emailed only to subscribers in them. None (the default): everyone`,
    )
    .meta({ examples: [["customers"]] }),
  emailOnly: z
    .boolean()
    .describe(
      "Email only: emailed to subscribers (published with `emailSubscribers`), and listed nowhere: not on the portal, in the widget, feeds or the API to readers; its page is the team's only, and its email links to none",
    )
    .meta({ examples: [false] }),
  cover: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .nullable()
    .optional()
    .describe(
      "Its featured image, also its link-preview image: an image upload's id (uploaded in the app), or an image's https:// URL, copied into your project as your upload (a 400 if it can't be fetched or isn't an image), and again each time it's sent (the link Tuti gave for one of your project's own images, a `cover.url` or one in an entry's `markdown`, is that upload, not a copy): to keep a cover, leave it out or send its `cover.id`; null for none, or to remove it",
    )
    .meta({ examples: ["https://cdn.example.com/releases/dark-mode.png", "cm3k9q2xv0001abcd1234efgh"] }),
};


const reactionsOutput = z
  .object({
    thumbs_up: z.number().int().describe("👍").meta({ examples: [4] }),
    heart: z.number().int().describe("❤️").meta({ examples: [2] }),
    tada: z.number().int().describe("🎉").meta({ examples: [1] }),
  })
  .meta({ id: "ChangelogReactions", description: "How many readers reacted with each: thumbs_up 👍, heart ❤️, tada 🎉" });

const entryOutput = z
  .object({
    number: z.number().int().describe("The entry's number in the project").meta({ examples: [7] }),
    title: z.string().describe("Its title").meta({ examples: ["Dark mode"] }),
    status: z.enum(["published", "draft"]).describe("Published on the portal, or a draft only the team sees").meta({ examples: ["published"] }),
    publishedAt: z
      .string()
      .nullable()
      .describe("When it was published (an imported one: when the other tool published it); null for a draft")
      .meta({ examples: ["2026-11-03T10:00:00.000Z"] }),
    announced: z.boolean().describe("Published with an announcement (shown as new in the widget), not quietly").meta({ examples: [true] }),
    collecting: z.boolean().describe("The running draft: merged pull requests are being added to it").meta({ examples: [false] }),
    tags: z.array(z.enum(TAGS)).describe("What kind of change it is").meta({ examples: [["new"]] }),
    groups: z
      .array(z.string())
      .optional()
      .describe("The keys of the reader groups it's for: only their readers (and the team) see it. None: everyone. Only for the team")
      .meta({ examples: [[]] }),
    emailOnly: z.boolean().optional().describe("Email only: emailed to subscribers, listed nowhere. Only for the team").meta({ examples: [false] }),
    body: z.string().describe("Its text, as plain text").meta({ examples: ["Switch themes from your profile menu."] }),
    content: doc.describe("Its text as rich content: the editor's JSON (a `doc`)").meta({ examples: [exampleDoc] }),
    markdown: z
      .string()
      .optional()
      .describe(
        "Its text as Markdown, its images as lasting links: to change it, edit this and send it to changelog.update as `markdown`, or one section of it to changelog.editSection; an image sent back by its link keeps its size and alignment, and a video's link stays its player. On one entry, not in changelog.list",
      )
      .meta({ examples: ["## Dark mode\n\nSwitch themes from your profile menu."] }),
    cover: z
      .object({
        id: z.string().describe("The upload's id").meta({ examples: ["cm3k9q2xv0001abcd1234efgh"] }),
        url: z.string().describe("A lasting link to its smallest stored size").meta({ examples: ["https://media.example.com/images/cm3k9q2xv0001abcd1234efgh-480.webp"] }),
        width: z.number().int().describe("Its width in pixels").meta({ examples: [1600] }),
        height: z.number().int().describe("Its height in pixels").meta({ examples: [900] }),
      })
      .nullable()
      .describe("Its featured image (cover), also its link-preview image; null for none"),
    posts: z
      .array(
        z.object({
          number: z.number().int().describe("The post's number").meta({ examples: [12] }),
          title: z.string().describe("Its title").meta({ examples: ["Add a dark mode"] }),
          url: z.string().describe("Its page on the portal").meta({ examples: ["https://feedback.example.com/feedback/ideas/add-a-dark-mode-12"] }),
        }),
      )
      .describe("The posts it completes; off the team, only the public ones"),
    pullRequests: z
      .array(
        z.object({
          repo: z.string().describe("The repository, owner/name").meta({ examples: ["acme/app"] }),
          number: z.number().int().describe("The pull request's number").meta({ examples: [418] }),
          url: z.string().describe("Its page").meta({ examples: ["https://github.com/acme/app/pull/418"] }),
          title: z.string().describe("Its title").meta({ examples: ["Add a dark theme"] }),
        }),
      )
      .describe("Merged pull requests the running draft collected"),
    reactions: reactionsOutput,
    url: z.string().describe("Its page on the portal").meta({ examples: ["https://feedback.example.com/changelog/7"] }),
    createdAt: z.string().describe("When it was written").meta({ examples: ["2026-11-01T14:30:00.000Z"] }),
    updatedAt: z
      .string()
      .describe("When it last changed: sent to changelog.update as `expectedUpdatedAt`, the edit is saved only if nothing changed since")
      .meta({ examples: ["2026-11-03T10:00:00.000Z"] }),
  })
  .meta({ id: "ChangelogEntry", description: "An entry in the project's changelog" });

const entrySelect = {
  id: true,
  emailOnly: true,
  number: true,
  title: true,
  body: true,
  content: true,
  tags: true,
  groups: groupClaims,
  publishedAt: true,
  announced: true,
  collecting: true,
  cover: { select: { id: true, status: true, width: true, height: true } },
  createdAt: true,
  updatedAt: true,
  sample: true,
  posts: { select: { post: { select: { id: true, number: true, title: true, status: true, sample: true, visibility: true, voteCount: true, board: { select: { slug: true, off: true } } } } } },
  pullRequests: { orderBy: { createdAt: "asc" }, select: { repo: true, number: true, url: true, title: true } },
} as const;

type EntryRow = NonNullable<Awaited<ReturnType<typeof findEntry>>>;

/**
 * An entry for the API; `counts` when its reactions were read already; `listed`: one of a list's, which go without their
 * Markdown; `team`: for the team, the only ones told its groups (a reader in one isn't told the others).
 */
async function entryView(entry: EntryRow, portal: PortalAddress, counts?: (entryId: string) => ReactionCounts, { listed = false, team = true } = {}) {
  const reactions = (counts ?? (await reactionCounts([entry.id])))(entry.id);
  const text = displayDoc(entry);
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
    ...(team && { groups: claimsOf(entry), emailOnly: entry.emailOnly }),
    body: entry.body,
    content: text,
    /** As Markdown, its images as lasting links (left out where uploads aren't set up): what an API client edits and sends back. */
    ...(!listed && { markdown: toMarkdown(text, { mediaUrls: lastingMediaUrls(text) }) }),
    /** The featured image (cover): a lasting link to its smallest stored size, and its size; null for none. */
    cover: lastingImage(entry.cover),
    // A real entry's real posts, a sample entry's sample ones (sample content, server/sample-content.ts, never mixes).
    posts: entry.posts.filter(({ post }) => post.sample === entry.sample).map(({ post }) => ({ number: post.number, title: post.title, url: `${portal}${postPath(post)}` })),
    /** Merged pull requests the running draft collected. */
    pullRequests: entry.pullRequests,
    /** How many readers reacted with each: thumbs_up 👍, heart ❤️, tada 🎉. */
    reactions,
    url: `${portal}/changelog/${entry.number}`,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/** API keys are the team's; people are when they're on the project's team (onTeam: never with a portal's session). Only the team sees drafts. */
export async function isTeam(actor: Actor, projectId: string): Promise<boolean> {
  return actor.kind === "apiKey" || onTeam(projectId, actor.userId);
}

/** An entry as someone off the team reads it: only its public posts (post-visibility.ts), as the portal lists them. */
const asReaderSees = (entry: EntryRow, team: boolean): EntryRow => (team ? entry : { ...entry, posts: entry.posts.filter(({ post }) => post.visibility === "PUBLIC" && !post.board.off) });

const findEntry = (projectId: string, number: number) =>
  prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: entrySelect });

/** Whether `actor` may read an entry for these groups' keys (as visibleEntry): one for some groups only is the team's and theirs. */
export async function mayReadEntry(actor: Actor, projectId: string, entry: { emailOnly: boolean; groups: { group: { key: string } }[] }): Promise<boolean> {
  const groups = claimsOf(entry);
  if (groups.length === 0 && !entry.emailOnly) {
    return true;
  }
  const reader = await actorReader(actor, projectId);
  // An email-only entry is the team's (visibleEntry).
  return reader === null || (!entry.emailOnly && groups.some((group) => reader.groups.includes(group)));
}

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

/**
 * Links posts to changelog entries (`skipDuplicates`: some may be linked already). Every path that links them goes
 * through it, as sample content (server/sample-content.ts) never mixes with the team's: a sample entry, removed with it,
 * can't complete (and email about) a real post, and a real entry can't announce a sample post as shipped.
 */
export async function linkEntryPosts(db: Prisma.TransactionClient, links: { entryId: string; postId: string }[], { skipDuplicates = false } = {}) {
  if (links.length === 0) {
    return;
  }
  const entries = await db.changelogEntry.findMany({ where: { id: { in: links.map((l) => l.entryId) } }, select: { id: true, sample: true } });
  const posts = await db.post.findMany({ where: { id: { in: links.map((l) => l.postId) } }, select: { id: true, sample: true } });
  const sample = new Set([...entries, ...posts].filter((row) => row.sample).map((row) => row.id));
  for (const { entryId, postId } of links) {
    if (sample.has(entryId) && !sample.has(postId)) {
      throw new OperationError(400, "invalid_input", "Sample updates can only complete sample posts");
    }
    if (!sample.has(entryId) && sample.has(postId)) {
      throw new OperationError(400, "invalid_input", "Sample posts can only be completed by the sample update");
    }
  }
  await db.changelogEntryPost.createMany({ data: links, skipDuplicates });
}

/**
 * Markdown's images and a cover's URL are copied before the save, so what would refuse it anyway (a cover that isn't this
 * project's finished image, a sample post on a real entry or the other way round) is checked first, and a refused request
 * copies none. The save checks both again, under its lock.
 */
async function refusedBeforeCopying(projectId: string, { cover, postIds, sample }: { cover?: string | null; postIds?: string[]; sample: boolean }) {
  if (cover && !isCoverUrl(cover) && (await prisma.media.count({ where: { id: cover, projectId, status: "READY", filename: null } })) === 0) {
    throw new OperationError(409, "media_gone", MEDIA_GONE);
  }
  if (postIds?.length && (await prisma.post.count({ where: { id: { in: postIds }, sample: !sample } })) > 0) {
    throw new OperationError(400, "invalid_input", sample ? "Sample updates can only complete sample posts" : "Sample posts can only be completed by the sample update");
  }
}

const uploaderOf = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

/** A cover given by URL, not by an upload's id (cuids, which never hold one). */
const isCoverUrl = (cover: string | null | undefined): cover is string => !!cover?.includes("://");

/**
 * `cover` as an upload's id: a URL's image is copied in first, as `actor`'s upload under the same limits (fetched like
 * webhooks: public addresses only), or refused with why. Network I/O: never under the project lock.
 */
async function coverId(projectId: string, actor: Actor, cover: string | null | undefined) {
  if (!isCoverUrl(cover)) {
    return cover;
  }
  const copied = await uploadImage(cover, { projectId, uploaderId: uploaderOf(actor) });
  if ("mediaId" in copied) {
    return copied.mediaId;
  }
  if (copied.passing) {
    throw new OperationError(503, "copy_failed", "Couldn't keep the cover just now: try again in a moment");
  }
  switch (copied.leftOut) {
    case "unsupported":
      throw new OperationError(503, "uploads_unavailable", "Uploads aren't set up on this server");
    case "quota":
      throw new OperationError(409, "no_room", "The cover can't be kept: this project has no space left for images, or you've uploaded a lot of images in the last hour");
    case "type":
      throw new OperationError(400, "invalid_cover", "The cover's URL isn't an image");
    case "size":
      throw new OperationError(400, "invalid_cover", `The cover can be up to ${Math.round(mediaLimit("teamImage") / (1024 * 1024))} MB`);
    default:
      throw new OperationError(400, "invalid_cover", "Couldn't fetch the cover: its URL must be a public https:// address that answers with the image");
  }
}

/**
 * Its text from `content`, else `markdown`, else `body`. Markdown's images are copied in as `actor`'s uploads, under the
 * same limits. `beforeCopying` (a cover's copy) runs once the text is known to be fine, before Markdown's images are copied.
 * `place` puts Markdown's blocks where they go in the text there is (one section's place, or its end).
 */
async function entryText(
  input: { body?: string; content?: unknown; markdown?: string },
  projectId: string,
  actor: Actor,
  beforeCopying: () => Promise<void>,
  place?: (blocks: NonNullable<Doc["content"]>) => Doc,
) {
  const fromMarkdown = input.markdown !== undefined && (input.content === undefined || input.content === null || input.content === "");
  if (fromMarkdown) {
    const html = await markdownToContent("changelog", input.markdown!, {
      projectId,
      uploaderId: uploaderOf(actor),
      maxLength: MAX_ENTRY_LENGTH,
      beforeCopying,
    });
    if ("error" in html) {
      throw new OperationError(400, "invalid_content", html.error);
    }
    input = { content: place ? place(html.doc.content ?? []) : html.doc };
  }
  const text = await readContent("changelog", input, { projectId, maxLength: MAX_ENTRY_LENGTH });
  if (text.error !== undefined) {
    throw new OperationError(400, "invalid_content", text.error);
  }
  if (!fromMarkdown) {
    await beforeCopying();
  }
  return text;
}

/**
 * Where an edit of part of the text puts its Markdown (changelog.editSection's `section` or `append`): in that section's
 * place, heading and all (`replaced`: what was there), or after everything; undefined for an edit of the whole text. They need `markdown`, one or the
 * other, and a section that's there.
 */
type Blocks = NonNullable<Doc["content"]>;

/**
 * Markdown read back from an entry (changelog.get) can't say an image's size and alignment, and writes a video as a
 * link named "Video" to its page (an entry's videos are YouTube's, Vimeo's or Loom's: uploaded ones are articles'). Sent back, an image the text already has keeps the size
 * and alignment it has there, and such a link to a video the text has is that video's player again: the round trip
 * changes only what was edited. A video only as a block of its own, where the Markdown wrote it: inside a list item,
 * say, the link stays a link (a video can't go there). `replaced` is what the Markdown takes the place of (the whole
 * text, or the one section): an image there more than once keeps each one's own layout, in the order they come
 * (Markdown names them alike, so their order is all that tells them apart). One brought in from elsewhere in the text
 * (an appended copy, another section's) takes the layout it first has there.
 */
function keepingMedia(whole: Blocks, replaced: Blocks, added: Blocks): Blocks {
  const videos = new Map<string, Blocks[number]>();
  const layoutsIn = (blocks: Blocks) => {
    const images = new Map<unknown, Record<string, unknown>[]>();
    blocks.forEach(function read(node: Blocks[number]) {
      if (node.type === "image" && node.attrs) {
        images.set(node.attrs.mediaId, [...(images.get(node.attrs.mediaId) ?? []), node.attrs]);
      } else if (node.type === "video" && node.attrs && isVideo(node.attrs)) {
        videos.set(videoPageUrl(node.attrs), node);
      }
      node.content?.forEach(read);
    });
    return images;
  };
  const [images, elsewhere] = [layoutsIn(replaced), layoutsIn(whole)];
  const sized = (node: Blocks[number]): Blocks[number] => {
    const layouts = node.type === "image" ? images.get(node.attrs?.mediaId) : undefined;
    // Each time it comes, the next one's; the last one's from then on.
    const had = layouts ? (layouts.length > 1 ? layouts.shift()! : layouts[0]) : node.type === "image" ? elsewhere.get(node.attrs?.mediaId)?.[0] : undefined;
    return had ? { ...node, attrs: { ...node.attrs, width: had.width, align: had.align } } : node.content ? { ...node, content: node.content.map(sized) } : node;
  };
  return added.map((node) => {
    // A paragraph that's nothing but toMarkdown's link for a video.
    const [only, ...rest] = node.type === "paragraph" ? (node.content ?? []) : [];
    const link = rest.length === 0 && only?.type === "text" && only.text === "Video" && only.marks?.length === 1 && only.marks[0]!.type === "link" && only.marks[0]!.attrs?.href;
    return (typeof link === "string" && videos.get(link)) || sized(node);
  });
}

function partOfText(entry: { content: unknown; body: string }, input: { markdown?: string; content?: unknown; section?: number | string; append?: boolean }) {
  if (input.section === undefined && !input.append) {
    return undefined;
  }
  const blocks = displayDoc(entry).content ?? [];
  const range = input.section === undefined ? { start: blocks.length, end: blocks.length } : sectionRange(blocks, input.section);
  if (!range) {
    throw new OperationError(400, "no_section", `There's no section ${typeof input.section === "string" ? `“${input.section}”` : input.section}`);
  }
  return {
    replaced: blocks.slice(range.start, range.end),
    place: (added: Blocks): Doc => ({ type: "doc", content: [...blocks.slice(0, range.start), ...added, ...blocks.slice(range.end)] }),
  };
}

/**
 * A cover being set: this project's finished upload (a 409 otherwise), attached before the entry points at it, which
 * locks it so the cleanup can't take it meanwhile. Replaced ones are released by release-media once nothing uses them.
 */
const attachCover = (tx: Parameters<typeof attachMedia>[0], projectId: string, cover: string | null | undefined) =>
  attachMedia(tx, projectId, cover ? [cover] : [], { images: true });

/** Publishing completed a published entry's posts; a post added now wouldn't be. The same list is fine. */
function keepsPublishedPosts(entry: { publishedAt: Date | null; posts: { post: { number: number } }[] }, wanted: number[]) {
  const now = new Set(entry.posts.map(({ post }) => post.number));
  const asked = new Set(wanted);
  if (entry.publishedAt && (now.size !== asked.size || [...asked].some((n) => !now.has(n)))) {
    throw new OperationError(409, "published", "Unpublish the entry to change the posts it completes");
  }
}

export const listChangelog = defineOperation({
  name: "changelog.list",
  title: "List changelog entries",
  summary: "List changelog entries: published ones, newest first, or the team's drafts, the most recently changed first",
  method: "GET",
  path: "/changelog",
  scope: "read",
  access: "anyone",
  input: z.object({
    status: z
      .enum(["published", "draft"])
      .default("published")
      .describe("Which ones: published (the default), or drafts, which only the team sees")
      .meta({ examples: ["published"] }),
    limit: z.coerce.number().int().min(1).max(50).default(20).describe("How many a page, 1 to 50 (default 20)").meta({ examples: [10] }),
    cursor: z.coerce.number().int().min(0).default(0).describe("Where the page starts: the previous page's `nextCursor`").meta({ examples: [10] }),
  }),
  output: z
    .object({
      entries: z.array(entryOutput).describe("A page of entries"),
      nextCursor: z.string().nullable().describe("The `cursor` for the next page; null on the last one").meta({ examples: ["10"] }),
    })
    .describe("A page of changelog entries"),
  example: { status: "published", limit: 10 },
  run: async ({ actor, projectId }, input) => {
    const portal = await projectPortal(projectId);
    const team = await isTeam(actor, projectId);
    if (input.status === "draft" && !team) {
      throw new OperationError(403, "forbidden", "Only the project's team sees drafts");
    }
    const published = input.status === "published";
    const entries = await prisma.changelogEntry.findMany({
      where: { projectId, publishedAt: published ? { not: null } : null, ...visibleEntry(team ? null : await actorReader(actor, projectId)) },
      orderBy: published ? [{ publishedAt: "desc" }, { number: "desc" }] : [{ updatedAt: "desc" }, { number: "desc" }],
      skip: input.cursor,
      take: input.limit + 1,
      select: entrySelect,
    });
    const shown = entries.slice(0, input.limit);
    const counts = await reactionCounts(shown.map((entry) => entry.id));
    return {
      entries: await Promise.all(shown.map((entry) => entryView(asReaderSees(entry, team), portal, counts, { listed: true, team }))),
      nextCursor: entries.length > input.limit ? String(input.cursor + input.limit) : null,
    };
  },
});

export const getChangelogEntry = defineOperation({
  name: "changelog.get",
  title: "Get a changelog entry",
  summary: "Get a changelog entry by its number. Drafts only for the team: to anyone else a draft isn't there (404)",
  method: "GET",
  path: "/changelog/{number}",
  scope: "read",
  access: "anyone",
  input: z.object({ number: entryNumber }),
  output: entryOutput.describe("The entry"),
  run: async ({ actor, projectId }, { number }) => {
    const portal = await projectPortal(projectId);
    const [entry, team] = await Promise.all([findEntry(projectId, number), isTeam(actor, projectId)]);
    // A draft is as good as missing to everyone but the team, and an entry for some groups to everyone outside them.
    if (!entry || (!entry.publishedAt && !team) || !(team || (await mayReadEntry(actor, projectId, entry)))) {
      throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
    }
    return entryView(asReaderSees(entry, team), portal, undefined, { team });
  },
});

export const reactToChangelogEntry = defineOperation({
  name: "changelog.react",
  title: "React to an entry",
  summary:
    "React to a published changelog entry or take the reaction back, as the key's creator or on behalf of someone from your app. One of each reaction a person; repeating one changes nothing. A draft takes none (409)",
  method: "POST",
  path: "/changelog/{number}/reactions",
  scope: "write",
  access: "anyone",
  errors: [409],
  input: z.object({
    number: entryNumber,
    reaction: z.enum(REACTIONS).describe("Which: thumbs_up 👍, heart ❤️ or tada 🎉").meta({ examples: ["tada"] }),
    reacted: z.boolean().describe("True to react, false to take the reaction back").meta({ examples: [true] }),
    author: author.describe("Who reacts: someone from your app, by their id there (created the first time); without it, the key's creator"),
  }),
  output: z
    .object({
      number: z.number().int().describe("The entry's number").meta({ examples: [7] }),
      reaction: z.enum(REACTIONS).describe("The reaction").meta({ examples: ["tada"] }),
      reacted: z.boolean().describe("Whether they now react with it").meta({ examples: [true] }),
      reactions: reactionsOutput,
    })
    .describe("The reaction and the entry's counts now"),
  example: { reaction: "tada", reacted: true, author: { id: "user-42" } },
  run: async (context, input) => {
    const { projectId } = context;
    const entry = await prisma.changelogEntry.findUnique({
      where: { projectId_number: { projectId, number: input.number } },
      select: { id: true, publishedAt: true, emailOnly: true, groups: groupClaims },
    });
    if (!entry || (!entry.publishedAt && !(await isTeam(context.actor, projectId))) || !(await mayReadEntry(context.actor, projectId, entry))) {
      throw new OperationError(404, "not_found", `There's no changelog entry #${input.number}`);
    }
    if (!entry.publishedAt) {
      throw new OperationError(409, "draft", "Only published entries take reactions");
    }
    const reaction = {
      entryId: entry.id,
      userId: await authorId(context, input.author),
      kind: input.reaction.toUpperCase() as ChangelogReactionKind,
    };
    // One of each per person, by the primary key: a repeat (a double click, a retry) changes nothing.
    if (input.reacted) {
      await prisma.changelogReaction.createMany({ data: reaction, skipDuplicates: true });
    } else {
      await prisma.changelogReaction.deleteMany({ where: reaction });
    }
    return {
      number: input.number,
      reaction: input.reaction,
      reacted: input.reacted,
      reactions: (await reactionCounts([entry.id]))(entry.id),
    };
  },
});

export const createChangelogEntry = defineOperation({
  name: "changelog.create",
  title: "Create a changelog entry",
  summary: "Write a changelog entry: a draft until it's published, with the posts it completes and its featured image",
  method: "POST",
  path: "/changelog",
  scope: "write",
  access: "team",
  errors: [402, 409, 503],
  input: z.object({ ...fields, tags: fields.tags.default([]), posts: fields.posts.default([]), groups: fields.groups.default([]), emailOnly: fields.emailOnly.default(false) }),
  output: entryOutput.describe("The entry, a draft"),
  example: { title: "Dark mode", body: "Switch themes from your profile menu.", tags: ["new"], posts: [12] },
  run: async ({ actor, projectId }, input) => {
    const portal = await projectPortal(projectId);
    // Before the text: Markdown's images and the cover's URL are copied as it's read, so a request refused anyway copies none.
    const posts = await postIds(projectId, input.posts);
    if (input.markdown !== undefined || isCoverUrl(input.cover)) {
      await refusedBeforeCopying(projectId, { cover: input.cover, postIds: posts, sample: false });
    }
    let cover = input.cover;
    const text = await entryText(input, projectId, actor, async () => {
      cover = await coverId(projectId, actor, input.cover);
    });
    const entry = await saving(() =>
      prisma.$transaction(async (tx) => {
        // Locks the project row, so concurrent entries get distinct numbers.
        const { changelogCount: number } = await tx.project.update({
          where: { id: projectId },
          data: { changelogCount: { increment: 1 } },
          select: { changelogCount: true },
        });
        await attachCover(tx, projectId, cover);
        const created = await tx.changelogEntry.create({
          data: {
            projectId,
            number,
            title: input.title,
            body: text.text,
            content: text.doc,
            tags: input.tags.map(toTag),
            emailOnly: input.emailOnly,
            coverId: cover ?? null,
            createdById: actor.kind === "user" ? actor.userId : actor.createdById,
          },
          select: { id: true },
        });
        await linkEntryPosts(tx, posts.map((postId) => ({ entryId: created.id, postId })));
        // The project's row is locked (above), as groups.delete locks it: a group deleted meanwhile is refused here or there.
        if (input.groups.length > 0) {
          await requirePlan(projectId, "privatePortal", tx);
          await tx.changelogEntryGroup.createMany({ data: (await groupLinks(tx, projectId, input.groups)).map((link) => ({ entryId: created.id, ...link })) });
        }
        await attachMedia(tx, projectId, text.mediaIds);
        return tx.changelogEntry.findUniqueOrThrow({ where: { id: created.id }, select: entrySelect });
      }),
    );
    return entryView(entry, portal);
  },
});

const updateInput = z.object({
    number: entryNumber,
    title: fields.title.optional(),
    body: fields.body,
    content: fields.content,
    markdown: fields.markdown,
    tags: fields.tags.optional(),
    emailOnly: fields.emailOnly.optional(),
    groups: fields.groups
      .optional()
      .describe(
        `The reader groups it's for, by key (see groups.list), up to ${MAX_READER_GROUPS}: they replace the list; none, for everyone. Only their readers (and the team) see it, and its emails still to send go only to subscribers in them`,
      ),
    posts: fields.posts
      .optional()
      .describe("The posts it completes, by number: they replace the list. Only while it's a draft (published, the same list or a 409)"),
    cover: fields.cover,
    expectedUpdatedAt: z.iso
      .datetime()
      .optional()
      .describe("Save only if the entry hasn't changed since (a 409 otherwise): the entry's `updatedAt`, or the `expectedUpdatedAt` changelog.rewrite returns")
      .meta({ examples: ["2026-11-03T10:00:00.000Z"] }),
  });

export const updateChangelogEntry = defineOperation({
  name: "changelog.update",
  title: "Update a changelog entry",
  summary: "Change a changelog entry: its title, text, tags, the reader groups it's for, featured image or the posts it completes. What's left out stays as it is",
  method: "PATCH",
  path: "/changelog/{number}",
  scope: "write",
  access: "team",
  errors: [402, 409, 503],
  input: updateInput,
  output: entryOutput.describe("The entry"),
  example: { tags: ["new", "improved"] },
  run: (context, input) => saveEntry(context, input),
});

type EntryEdit = z.infer<typeof updateInput> & {
  /** The one section `markdown` replaces (changelog.editSection), by its heading or number. */
  section?: number | string;
  /** `markdown` goes at the end of the text (changelog.editSection). */
  append?: boolean;
};

/** An edit of an entry: changelog.update's, or changelog.editSection's of part of its text. */
async function saveEntry({ actor, projectId }: { actor: Actor; projectId: string }, input: EntryEdit) {
    const portal = await projectPortal(projectId);
    const entry = await teamEntry(projectId, input.number);
    if (input.posts) {
      keepsPublishedPosts(entry, input.posts);
    }
    // What the client read has changed since: said first, before a section it names is looked for (renamed meanwhile,
    // "there's no such section" would send it elsewhere, where "changed, reload" is what happened).
    if (input.expectedUpdatedAt && entry.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
      throw new OperationError(409, "changed", "The entry changed since. Reload it and try again.");
    }
    // Part of the text only: Markdown for one section, or to add at its end. The rest is the text as it's read here,
    // so it's saved only if the entry hasn't changed meanwhile (as with `expectedUpdatedAt`, which it stands in for).
    const part = partOfText(entry, input);
    const expectedUpdatedAt = input.expectedUpdatedAt ?? (part ? entry.updatedAt.toISOString() : undefined);
    // Markdown, the whole text's or a part's: what it can't say about the images and videos it takes the place of is kept.
    const whole = displayDoc(entry).content ?? [];
    const place = (added: Blocks): Doc => (part ? part.place(keepingMedia(whole, part.replaced, added)) : { type: "doc", content: keepingMedia(whole, whole, added) });
    // (Checked again under the lock below; above first, so Markdown's images and a cover's URL aren't copied for an edit refused anyway.)
    const posts = input.posts && (await postIds(projectId, input.posts));
    if (input.markdown !== undefined || isCoverUrl(input.cover)) {
      await refusedBeforeCopying(projectId, { cover: input.cover, postIds: posts, sample: entry.sample });
    }
    let cover = input.cover;
    const copyCover = async () => {
      cover = await coverId(projectId, actor, input.cover);
    };
    const text = input.body !== undefined || input.content !== undefined || input.markdown !== undefined ? await entryText(input, projectId, actor, copyCover, place) : null;
    if (!text) {
      await copyCover();
    }
    const updated = await saving(() =>
      prisma.$transaction(async (tx) => {
        // The project's lock first, as publishing and the email job's claims take it before the entry's row (below, and
        // in its update), so they can't deadlock. Groups need it too: groups.delete locks it (see changelog.create).
        if (posts || input.groups) {
          await lockProject(tx, projectId);
        }
        if (posts) {
          // Checked again after a publish that's committing: the posts it completed stay.
          keepsPublishedPosts(
            await tx.changelogEntry.findUniqueOrThrow({ where: { id: entry.id }, select: { publishedAt: true, posts: { select: { post: { select: { number: true } } } } } }),
            input.posts!,
          );
        }
        if (expectedUpdatedAt) {
          // Locked until this commits, so a save in between can't slip past the check.
          const [now] = await tx.$queryRaw<{ updatedAt: Date }[]>`
            SELECT "updatedAt" FROM changelog_entry WHERE id = ${entry.id} FOR UPDATE`;
          if (now?.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
            throw new OperationError(409, "changed", "The entry changed since. Reload it and try again.");
          }
        }
        if (input.groups) {
          // Adding a group needs the plan; taking some off (back to everyone, too) never does, so a lower plan can undo them.
          const links = await groupLinks(tx, projectId, input.groups);
          const had = new Set((await tx.changelogEntryGroup.findMany({ where: { entryId: entry.id }, select: { groupId: true } })).map((link) => link.groupId));
          if (links.some((link) => !had.has(link.groupId))) {
            await requirePlan(projectId, "privatePortal", tx);
          }
          await tx.changelogEntryGroup.deleteMany({ where: { entryId: entry.id } });
          await tx.changelogEntryGroup.createMany({ data: links.map((link) => ({ entryId: entry.id, ...link })) });
        }
        if (posts) {
          await tx.changelogEntryPost.deleteMany({ where: { entryId: entry.id } });
          await linkEntryPosts(tx, posts.map((postId) => ({ entryId: entry.id, postId })));
        }
        // A line still to fill in ("[Check: …]", "[Screenshot: …]") isn't added to an entry that's out to readers, as
        // it isn't published with one: read under the entry's lock, so a save that waited for a publish finds it
        // published. Only ones this save adds: text that had such a line already (an older or imported entry's) is
        // still edited, and can lose it.
        if (text && markersIn(text.doc).length > 0) {
          // The entry as it is now, held: what this save read before may be a draft that has since lost the line and gone out.
          const [now] = await tx.$queryRaw<{ publishedAt: Date | null; content: Prisma.JsonValue; body: string }[]>`SELECT "publishedAt", content, body FROM changelog_entry WHERE id = ${entry.id} FOR UPDATE`;
          const markers = now?.publishedAt ? droppedMarkers(text.doc, displayDoc(now)) : [];
          if (markers.length > 0) {
            throw new OperationError(409, "markers", `This entry is published. Replace or remove ${markers.length === 1 ? "the marker" : `the ${markers.length} markers`} in its text first: ${markers.join(" ")}`);
          }
        }
        await attachCover(tx, projectId, cover);
        const saved = await tx.changelogEntry.update({
          where: { id: entry.id },
          data: {
            ...(input.title !== undefined && { title: input.title }),
            ...(text && { body: text.text, content: text.doc }),
            ...(input.tags && { tags: input.tags.map(toTag) }),
            // ponytail: an email-only entry's email, sent by the previous release's worker while a deploy runs both, links
            // to its page (a 404 for readers); its text is all there. A release apart if that matters.
            ...(input.emailOnly !== undefined && { emailOnly: input.emailOnly }),
            ...(cover !== undefined && { coverId: cover }),
          },
          select: entrySelect,
        });
        if (text) {
          await attachMedia(tx, projectId, text.mediaIds);
        }
        return saved;
      }),
    );
    return entryView(updated, portal);
}

export const editChangelogSection = defineOperation({
  name: "changelog.editSection",
  title: "Change one section of an entry",
  summary:
    "Replace one section of an entry's text with Markdown, or add Markdown at its end; the rest of the text stays as it is. Saved only if the entry hasn't changed since it was read (a 409 otherwise)",
  method: "POST",
  path: "/changelog/{number}/section",
  scope: "write",
  access: "team",
  errors: [409, 503],
  input: z.object({
    number: entryNumber,
    markdown: z
      .string()
      // As changelog.update's: its markup counts too, and the text it makes is held to the entry's limit.
      .max(MAX_ENTRY_LENGTH * 2)
      .describe("The section's new text as Markdown, its heading included; or the text to add. Images are copied in as on changelog.update; the entry's own, by the links its `markdown` gives, stay the same uploads")
      .meta({ examples: ["## Dark mode\n\nSwitch themes from your profile menu, any time of day."] }),
    section: z
      .union([z.number().int().min(0), z.string().trim().min(1).max(200)])
      .optional()
      .describe("The section to replace, by its heading or its number (1 for the first heading, 0 for the text before it): it runs to the next heading at its level or above. Without it, send `append`")
      .meta({ examples: ["Dark mode"] }),
    append: z.boolean().optional().describe("Add the Markdown at the end of the text instead of replacing a section").meta({ examples: [false] }),
    expectedUpdatedAt: z.iso
      .datetime()
      .optional()
      .describe("Save only if the entry hasn't changed since this (its `updatedAt` when you read it); without it, since this request read it")
      .meta({ examples: ["2026-11-03T10:00:00.000Z"] }),
  }),
  output: entryOutput.describe("The entry, with the section changed"),
  example: { section: "Dark mode", markdown: "## Dark mode\n\nSwitch themes from your profile menu, any time of day." },
  run: (context, input) => {
    if ((input.section === undefined) === (input.append !== true)) {
      throw new OperationError(400, "invalid_input", "Send `section` or `append: true`, one of them");
    }
    return saveEntry(context, input);
  },
});

export const composeChangelogCover = defineOperation({
  name: "changelog.composeCover",
  title: "Make an entry's cover",
  summary:
    "Compose a featured image for an entry from what it and the portal already have (its title, first tag, headings and first image; the portal's logo, colour and look), and set it as the entry's cover, replacing the one it has. No AI",
  method: "POST",
  path: "/changelog/{number}/cover/compose",
  scope: "write",
  access: "team",
  errors: [409, 503],
  input: z.object({
    number: entryNumber,
    design: z
      .enum(["auto", ...COVER_DESIGNS])
      .default("auto")
      .describe(
        "The design: `title` (the portal's colour and the title), `screenshot` (the entry's first image, at least 600px wide, beside the title), `sections` (the title beside the entry's headings: needs two), `pattern` (the title on the portal's page), `background` (the title on the team's own image: needs one, `coverBackground` in changelogStyle.update); `auto` is the team's `coverDesign` where the entry has what it needs, else `screenshot` where the entry has such an image, else `title`",
      )
      .meta({ examples: ["auto"] }),
    headline: z
      .string()
      .trim()
      .max(MAX_COVER_HEADLINE, `Keep the headline under ${MAX_COVER_HEADLINE} characters`)
      .optional()
      .describe(`Shown in the title's place, under ${MAX_COVER_HEADLINE} characters; without it, the entry's title`)
      .meta({ examples: ["Dark mode is here"] }),
  }),
  output: entryOutput.describe("The entry, with its new cover"),
  example: { design: "auto" },
  run: (context, input) => composeCover(context, input),
});

/**
 * changelog.composeCover's work. `ifBare` (the Publish dialog's pick): the cover is set only on a draft that still has
 * none when it's drawn, so a cover a teammate set, or an entry they published, meanwhile stays as it is.
 */
export async function composeCover(
  { actor, projectId }: { actor: Actor; projectId: string },
  { number, design, headline }: { number: number; design: CoverDesign | "auto"; headline?: string },
  { ifBare = false } = {},
) {
  const portal = await projectPortal(projectId);
  const entry = await teamEntry(projectId, number);
  // Nothing to draw: it has a cover or is out (checked again where it's set, as that can change while the cover is drawn),
  // or it has lines left to fill in, so publishing will refuse it and a cover would be kept for nothing.
  if (ifBare && (entry.cover !== null || entry.publishedAt !== null || markersIn(displayDoc(entry)).length > 0)) {
    return entryView(entry, portal);
  }
  if (!mediaStorage()) {
    throw new OperationError(503, "uploads_unavailable", "Uploads aren't set up on this server");
  }
  const [brand, project] = await Promise.all([branding({ id: projectId }), prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } })]);
  const content = await coverContent(projectId, entry, headline);
  const picked = design === "auto" ? automaticDesign(content) : design;
  if (!coverDesigns(content).includes(picked)) {
    throw new OperationError(
      400,
      "invalid_input",
      picked === "screenshot"
        ? "This entry has no image at least 600px wide for the Screenshot design"
        : picked === "background"
          ? "This project has no cover background for the Your background design yet"
          : "This entry needs two headings for the Sections design",
    );
  }
  // Drawing and storing: never under the project lock (storeImage takes it itself). A design asked for by name is that
  // design or nothing: Screenshot whose image storage won't give just now isn't kept as a Title cover (`auto` is).
  const png = await drawCover({ project, brand: brand! }, content, picked, undefined, { asAsked: design !== "auto" }).catch((error: unknown) => {
    if (error instanceof CoverPictureUnread) {
      throw new OperationError(503, "copy_failed", `Couldn't read ${picked === "background" ? "the cover background" : "the entry's image"} just now: try again in a moment`);
    }
    throw error;
  });
  const stored = await storeImage(png, { projectId, uploaderId: uploaderOf(actor) });
  if (!("mediaId" in stored)) {
    throw stored.leftOut === "quota"
      ? new OperationError(409, "no_room", "The cover can't be kept: this project has no space left for images, or you've uploaded a lot of images in the last hour")
      : new OperationError(503, "copy_failed", "Couldn't keep the cover just now: try again in a moment");
  }
  const updated = await saving(() =>
    prisma.$transaction(async (tx) => {
      await attachCover(tx, projectId, stored.mediaId);
      // Deleted while its cover was drawn: gone, not an error of ours (the upload, in no entry, is freed like any unused one).
      const { count } = await tx.changelogEntry.updateMany({
        where: { id: entry.id, ...(ifBare && { coverId: null, publishedAt: null }) },
        data: { coverId: stored.mediaId },
      });
      const now = await tx.changelogEntry.findUnique({ where: { id: entry.id }, select: entrySelect });
      if (!now) {
        throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
      }
      // Covered or published meanwhile: theirs stays, and the drawing (attached above) goes with this transaction.
      if (count === 0) {
        throw new Kept(now);
      }
      return now;
    }),
  ).catch((error: unknown) => {
    if (error instanceof Kept) {
      return error.entry;
    }
    throw error;
  });
  return entryView(updated, portal);
}

/** Rolls back a cover that's no longer wanted, carrying the entry as it is. */
class Kept extends Error {
  constructor(readonly entry: Prisma.ChangelogEntryGetPayload<{ select: typeof entrySelect }>) {
    super("kept");
  }
}

export const draftChangelogEntry = defineOperation({
  name: "changelog.draft",
  title: "Draft an entry with AI",
  summary:
    "Replace a draft entry's text with release notes the AI writes from its pull requests (with what Autopilot found each changed for users), the public posts it completes, most voted first, and its text, and name it if it still has the running draft's title. A published entry is a 409",
  method: "POST",
  path: "/changelog/{number}/draft",
  scope: "write",
  access: "team",
  errors: [402, 409, 502, 503],
  input: z.object({ number: entryNumber }),
  output: entryOutput.describe("The entry, with the AI's text"),
  run: async ({ projectId }, { number }) => {
    const portal = await projectPortal(projectId);
    if (!aiEnabled()) {
      throw new OperationError(503, "ai_unavailable", "AI isn't set up on this server");
    }
    const entry = await teamEntry(projectId, number);
    if (entry.publishedAt) {
      throw new OperationError(409, "published", "Unpublish the entry to draft its text with AI");
    }
    // Only its public posts: the text goes to the portal, RSS, the widget and subscribers' email, so a private or Team
    // only post's title and link stay out of it (and a link to one the model makes up anyway is dropped below).
    const reader = asReaderSees(entry, false);
    const { posts } = await entryView(reader, portal);
    if (posts.length === 0 && entry.pullRequests.length === 0 && entry.body.trim() === "") {
      throw new OperationError(400, "nothing_to_draft", "Pick the public posts it completes or write a few notes first");
    }
    // Those posts with their votes, and what Autopilot knows of each pull request.
    const listed = new Map(reader.posts.map(({ post }) => [post.number, post]));
    const asked = posts.map((post) => ({ title: post.title, url: post.url, votes: listed.get(post.number)!.voteCount, id: listed.get(post.number)!.id }));
    const pullRequests = await withAutopilotNotes(projectId, entry.pullRequests, asked);
    const { screenshotMarkers, ...style } = await writingStyle(projectId, entry.id);
    const ai = await aiOrRefuse(projectId, "changelog");
    let reply: string;
    try {
      reply = await complete({ ...releaseNotesPrompt({ posts: asked, pullRequests, text: entry.body, style, screenshotMarkers }), ...ai });
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
    return entryView(await teamEntry(projectId, number), portal);
  },
});

/**
 * A draft's pull requests with what Autopilot found (code-changes.ts): each one's summary for users, where its analysis
 * wrote one, and which of `posts` it's linked to (a post's pull request links, whoever made them). Only those posts:
 * a link to one the entry doesn't list, or lists but readers can't see, says nothing here.
 */
async function withAutopilotNotes<PullRequest extends { repo: string; number: number }>(
  projectId: string,
  pullRequests: PullRequest[],
  posts: { id: string; url: string }[],
) {
  if (pullRequests.length === 0) {
    return [];
  }
  const theirs = { repo: { in: pullRequests.map((pr) => pr.repo) }, number: { in: pullRequests.map((pr) => pr.number) } };
  const [changes, links] = await Promise.all([
    prisma.codeChange.findMany({ where: { projectId, summary: { not: "" }, ...theirs }, select: { repo: true, number: true, summary: true } }),
    prisma.postLink.findMany({
      where: { projectId, kind: "PULL_REQUEST", postId: { in: posts.map((post) => post.id) }, ...theirs },
      select: { repo: true, number: true, postId: true },
    }),
  ]);
  const url = new Map(posts.map((post) => [post.id, post.url]));
  return pullRequests.map((pr) => {
    const same = (row: { repo: string; number: number | null }) => row.repo === pr.repo && row.number === pr.number;
    return { ...pr, summary: changes.find(same)?.summary, completes: links.filter(same).map((link) => url.get(link.postId)!) };
  });
}

export const MAX_INSTRUCTION_LENGTH = 200;
/** AI edits (changelog.rewrite) a project may ask for per clock hour, all of its team together. */
export const AI_EDITS_PER_HOUR = 60;

export const rewriteChangelogEntry = defineOperation({
  name: "changelog.rewrite",
  title: "Rewrite an entry with AI",
  summary: `Propose an AI edit of an entry's text, without saving it. To accept it, send \`proposed.content\` to changelog.update with \`expectedUpdatedAt\`. Up to ${AI_EDITS_PER_HOUR} AI edits an hour per project, its whole team together (then a 429)`,
  method: "POST",
  path: "/changelog/{number}/rewrite",
  scope: "write",
  access: "team",
  errors: [402, 429, 502, 503],
  input: z.object({
    number: entryNumber,
    mode: z
      .enum(REWRITE_MODES)
      .describe("The edit: `shorten` it, explain it for non-developers (`plain`), or rewrite a `section` so it reads better (needs `section`)")
      .meta({ examples: ["shorten"] }),
    section: z
      .union([z.number().int().min(0), z.string().trim().min(1).max(200)])
      .optional()
      .describe("The one section to edit: its heading, or its number (1 for the first heading, 0 for the text before it); without it, the whole text")
      .meta({ examples: ["Dark mode"] }),
    instruction: z
      .string()
      .trim()
      .max(MAX_INSTRUCTION_LENGTH, `Keep the instruction under ${MAX_INSTRUCTION_LENGTH} characters`)
      .optional()
      .describe(`Optional: what the AI should do too, under ${MAX_INSTRUCTION_LENGTH} characters`)
      .meta({ examples: ["Mention it follows the system setting"] }),
  }),
  output: z
    .object({
      number: z.number().int().describe("The entry's number").meta({ examples: [7] }),
      mode: z.enum(REWRITE_MODES).describe("The edit").meta({ examples: ["shorten"] }),
      section: z
        .object({
          index: z.number().int().describe("Its number: 1 for the first heading, 0 for the text before it").meta({ examples: [1] }),
          heading: z.string().nullable().describe("Its heading; null for the text before the first one").meta({ examples: ["Dark mode"] }),
        })
        .nullable()
        .describe("The section it edited; null for the whole text"),
      body: z.string().describe("The entry's text now, as plain text").meta({ examples: ["Dark mode\nYou can now switch to a dark theme from your profile menu, any time of day."] }),
      proposed: z
        .object({
          content: doc.describe("The whole entry's text with the edit, as rich content: send it to changelog.update to accept it").meta({ examples: [exampleDoc] }),
          body: z.string().describe("The same, as plain text").meta({ examples: ["Switch themes from your profile menu."] }),
        })
        .describe("The whole entry's text with the edit, not saved"),
      expectedUpdatedAt: z
        .string()
        .describe("Send it with the proposed content to changelog.update: saving it then only works if the entry hasn't changed since")
        .meta({ examples: ["2026-11-03T10:00:00.000Z"] }),
    })
    .describe("The proposed edit"),
  example: { mode: "section", section: "Dark mode", instruction: "Mention it follows the system setting" },
  run: async ({ projectId }, input) => {
    const portal = await projectPortal(projectId);
    if (!aiEnabled()) {
      throw new OperationError(503, "ai_unavailable", "AI isn't set up on this server");
    }
    if (input.mode === "section" && input.section === undefined) {
      throw new OperationError(400, "invalid_input", "Pick the section to rewrite");
    }
    const entry = await teamEntry(projectId, input.number);
    const doc = displayDoc(entry);
    const blocks = doc.content ?? [];
    const range = input.section === undefined ? { start: 0, end: blocks.length, index: null, heading: null } : sectionRange(blocks, input.section);
    if (!range) {
      throw new OperationError(400, "no_section", `There's no section ${typeof input.section === "string" ? `“${input.section}”` : input.section}`);
    }
    const target = blocks.slice(range.start, range.end);
    const media: NonNullable<Doc["content"]> = [];
    const text = blocksToNotes(target, media);
    if (text.trim() === "") {
      throw new OperationError(400, "nothing_to_rewrite", "There's no text to rewrite yet");
    }
    const ai = await aiOrRefuse(projectId, "changelog");
    await countAiEdit(projectId);
    const { posts } = await entryView(asReaderSees(entry, false), portal);
    let reply: string;
    try {
      reply = await complete({
        ...rewritePrompt({
          mode: input.mode,
          text,
          entry: target.length < blocks.length ? toMarkdown(doc) : undefined,
          instruction: input.instruction || undefined,
          style: await writingStyle(projectId, entry.id),
        }),
        ...ai,
      });
    } catch (error) {
      log.warn("AI changelog rewrite failed", { projectId, number: input.number, error });
      throw new OperationError(502, "ai_failed", "The AI couldn't edit the text. Try again in a moment.");
    }
    // Links can be kept, or go to the entry's posts; nothing else.
    const before = factsIn(target);
    const links = [...before.keys()].filter((key) => key.startsWith("link ")).map((key) => key.slice("link ".length));
    const rewritten = readReleaseNotes(reply, new Set([...links, ...posts.map((post) => post.url)]), media);
    // Checked like anything the team saves.
    const proposed =
      rewritten &&
      (await readContent(
        "changelog",
        { content: { type: "doc", content: [...blocks.slice(0, range.start), ...rewritten.doc.content!, ...blocks.slice(range.end)] } },
        { projectId, maxLength: MAX_ENTRY_LENGTH },
      ));
    if (!rewritten || !proposed || proposed.error !== undefined) {
      log.warn("AI changelog rewrite unusable", { projectId, number: input.number, reply: reply.slice(0, 500) });
      throw new OperationError(502, "ai_failed", "The AI's version couldn't be used. Try again.");
    }
    // Facts are checked, not trusted: a version that drops a link, an image or a video isn't offered.
    // Nor one that drops a line the team still has to fill in: accepted, the entry could be published with the question never answered.
    const unanswered = droppedMarkers({ type: "doc", content: target }, rewritten.doc);
    const dropped = [...droppedFacts(target, rewritten.doc.content!), ...(unanswered.length > 0 ? [unanswered.length === 1 ? "a line still to fill in" : `${unanswered.length} lines still to fill in`] : [])];
    if (dropped.length > 0) {
      const list = dropped.length > 1 ? `${dropped.slice(0, -1).join(", ")} and ${dropped.at(-1)}` : dropped[0];
      throw new OperationError(502, "dropped_facts", `The AI's version left out ${list}, so it wasn't used. Try again.`);
    }
    return {
      number: input.number,
      mode: input.mode,
      /** The section it edited (null: the whole text). */
      section: range.index === null ? null : { index: range.index, heading: range.heading },
      /** The entry's text now, as plain text. */
      body: toPlainText(doc),
      /** The whole entry's text with the edit, not saved. */
      proposed: { content: proposed.doc, body: proposed.text },
      /** Send with the proposed content to changelog.update: it's saved only if the entry hasn't changed since. */
      expectedUpdatedAt: entry.updatedAt.toISOString(),
    };
  },
});

/** Counts an AI edit against the project's hourly cap, or refuses it (429). */
async function countAiEdit(projectId: string) {
  // ponytail: a fixed clock hour, so up to twice the cap fits across an hour's edge; a sliding window if that matters.
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  // Atomic: concurrent edits each get their own count.
  const [row] = await prisma.$queryRaw<{ count: number }[]>`
    UPDATE project
    SET "changelogAiCount" = CASE WHEN "changelogAiHour" = ${hour} THEN "changelogAiCount" + 1 ELSE 1 END,
        "changelogAiHour" = ${hour}
    WHERE id = ${projectId}
    RETURNING "changelogAiCount" AS count`;
  if (!row || row.count > AI_EDITS_PER_HOUR) {
    throw new OperationError(429, "rate_limited", `Your team has made ${AI_EDITS_PER_HOUR} AI edits this hour. Try again later.`);
  }
}

const NOT_CONNECTED = "Connect GitHub first (Settings → Integrations)";
/** GitHub's answer, or a 502 saying it didn't give one (its token refused, a repository gone, its API down). */
async function fromGithub<T>(projectId: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    log.warn("GitHub couldn't be read for the changelog's pull requests", { projectId, error });
    throw new OperationError(502, "github_failed", "GitHub didn't answer. Try again in a moment.");
  }
}

/** The analyses going on after their request answered (jobs in-process). */
const inBackground = new Set<Promise<void>>();
/** Once every analysis `changelog.addPullRequests` left running in this process has ended: for tests, which wait for them rather than watch the clock. */
export const addedPullRequestsAnalysed = (): Promise<unknown> => Promise.all([...inBackground]);

/**
 * How far back merged pull requests are looked for at least: one taken out of a draft that has since been published
 * (it ships in a later release) merged before that entry went out, and is still to be found.
 */
const MISSING_SINCE_DAYS = 30;
/** Pull requests added to the changelog in one request: each is read from GitHub, and analysed where Autopilot is on. */
export const MAX_ADDED_PULL_REQUESTS = 50;

const pullRequestRef = z.object({
  repo: z.string().trim().min(3).max(200).describe("The repository, owner/name: one the project includes").meta({ examples: ["acme/app"] }),
  number: z.number().int().positive().describe("The pull request's number").meta({ examples: [418] }),
});

export const listMissingChanges = defineOperation({
  name: "changelog.missingChanges",
  title: "List missing pull requests",
  summary:
    "List the pull requests merged on the project's repositories that are in no changelog entry: ones merged before GitHub was connected (since `since`), and ones taken out of a draft, whenever they merged. Read from GitHub; no AI",
  method: "GET",
  path: "/changelog-pull-requests",
  scope: "read",
  access: "team",
  errors: [409, 502],
  input: z.object({
    since: z.iso
      .datetime()
      .optional()
      .describe(`Merged since then; without it, the last ${MISSING_SINCE_DAYS} days, or since the latest entry was published if that's longer ago`)
      .meta({ examples: ["2026-11-01T00:00:00.000Z"] }),
  }),
  output: z
    .object({
      since: z
        .string()
        .describe(
          "Merged since then: the date asked for (or the default), or a later one where a repository has more closed pull requests since that date than are read at once (its latest 2,000), so the list reaches no further back",
        )
        .meta({ examples: ["2026-11-01T00:00:00.000Z"] }),
      pullRequests: z
        .array(
          pullRequestRef.extend({
            title: z.string().describe("Its title").meta({ examples: ["Add a dark theme"] }),
            url: z.string().describe("Its page").meta({ examples: ["https://github.com/acme/app/pull/418"] }),
            author: z.string().describe("Who opened it").meta({ examples: ["octocat"] }),
            mergedAt: z.string().describe("When it merged").meta({ examples: ["2026-11-02T09:30:00.000Z"] }),
            forUsers: z
              .boolean()
              .nullable()
              .describe("What Autopilot found: true if it changes something users see, false if nothing for them; null if it hasn't analysed it")
              .meta({ examples: [true] }),
          }),
        )
        .describe("Newest first"),
    })
    .meta({ id: "MissingChanges", description: "Merged pull requests that are in no changelog entry" })
    .describe("The merged pull requests no entry has"),
  run: async ({ projectId }, input) => {
    const latest = await prisma.changelogEntry.findFirst({ where: { projectId, publishedAt: { not: null }, sample: false }, orderBy: { publishedAt: "desc" }, select: { publishedAt: true } });
    const lately = new Date(Date.now() - MISSING_SINCE_DAYS * 86_400_000);
    const asked = input.since ? new Date(input.since) : latest?.publishedAt && latest.publishedAt < lately ? latest.publishedAt : lately;
    const github = await fromGithub(projectId, () => mergedPullRequests(projectId, asked));
    if (!github) {
      throw new OperationError(409, "github_not_connected", NOT_CONNECTED);
    }
    const { since, repos } = github;
    // And the ones the team took out of a draft, however long ago they merged (a draft that collected for weeks, a
    // release that waited): they're what this list is for. Only on repositories the project still includes (adding
    // one from elsewhere would be refused), under their names now.
    const takenOut = await prisma.changelogDecision.findMany({
      where: { projectId, takenOut: true, repoId: { in: repos.map((repo) => repo.repoId) }, mergedAt: { lt: since } },
      select: { repoId: true, number: true, title: true, url: true, author: true, mergedAt: true },
    });
    const all = [
      ...github.pullRequests,
      ...takenOut.map((decision) => ({ ...decision, repo: repos.find((repo) => repo.repoId === decision.repoId)!.fullName, mergedAt: decision.mergedAt.toISOString() })),
    ].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    const keys = { projectId, repoId: { in: all.map((pr) => pr.repoId) }, number: { in: all.map((pr) => pr.number) } };
    const [changes, decisions] = await Promise.all([
      prisma.codeChange.findMany({
        where: keys,
        select: { repoId: true, number: true, url: true, forUsers: true },
      }),
      prisma.changelogDecision.findMany({ where: keys, select: { repoId: true, number: true, url: true } }),
    ]);
    // Indexed once: a busy repository lists thousands.
    const key = (pr: { repoId: number; number: number }) => `${pr.repoId}#${pr.number}`;
    const byKey = <T extends { repoId: number; number: number }>(rows: T[]) => new Map(rows.map((row) => [key(row), row]));
    const [changeOf, decisionOf] = [byKey(changes), byKey(decisions)];
    // Every page the project knows each by: an entry's row keeps the one it was written with, a renamed repository's old one.
    const urls = (pr: { repoId: number; number: number; url: string }) => [pr.url, changeOf.get(key(pr))?.url, decisionOf.get(key(pr))?.url].filter((url): url is string => url !== undefined);
    const inEntries = await prisma.changelogEntryPullRequest.findMany({ where: { entry: { projectId }, url: { in: all.flatMap(urls) } }, select: { url: true } });
    const known = new Set(inEntries.map((pr) => pr.url));
    return {
      since: since.toISOString(),
      pullRequests: all
        .filter((pr) => !urls(pr).some((url) => known.has(url)))
        .map(({ repoId, ...pr }) => {
          const change = changeOf.get(key({ repoId, number: pr.number }));
          // The gate's word, as its analysis saved it (the migration filled it in for ones analysed before); null where
          // the gate was never asked (not analysed, or only past it).
          return { ...pr, forUsers: change?.forUsers ?? null };
        }),
    };
  },
});

export const addChangelogPullRequests = defineOperation({
  name: "changelog.addPullRequests",
  title: "Add pull requests",
  summary:
    "Add merged pull requests to the running draft (\"Next release\", started if there's none), as a merge does: a line each, and its analysis where Autopilot is on. One already in an entry stays where it is",
  method: "POST",
  path: "/changelog-pull-requests",
  scope: "write",
  access: "team",
  errors: [409, 502],
  input: z.object({
    pullRequests: z
      .array(pullRequestRef)
      .min(1)
      .max(MAX_ADDED_PULL_REQUESTS, `Add up to ${MAX_ADDED_PULL_REQUESTS} pull requests at a time`)
      .describe(`The pull requests to add, up to ${MAX_ADDED_PULL_REQUESTS}: merged ones, on the project's repositories`),
  }),
  output: z
    .object({
      number: z.number().int().nullable().describe("The running draft's number; null if nothing was added and there's none").meta({ examples: [8] }),
      added: z.array(pullRequestRef).describe("Those added to it"),
      alreadyIn: z.array(pullRequestRef).describe("Those an entry already had: left where they are"),
    })
    .meta({ id: "AddedPullRequests", description: "What adding pull requests to the changelog did" })
    .describe("The running draft, and which were added"),
  example: { pullRequests: [{ repo: "acme/app", number: 418 }] },
  run: async ({ projectId }, input) => {
    // Each as GitHub has it now, all read before any is added: one that isn't a merged pull request of the project's adds none.
    const read = await fromGithub(projectId, () => mergedPullRequestsByRef(projectId, input.pullRequests));
    if (!read) {
      throw new OperationError(409, "github_not_connected", NOT_CONNECTED);
    }
    const merged = read.map((pr, i) => {
      const { repo, number } = input.pullRequests[i]!;
      if (pr === "unknown" || pr === "open") {
        throw new OperationError(400, "invalid_input", pr === "open" ? `${repo}#${number} isn't merged` : `There's no pull request ${repo}#${number} on the project's repositories`);
      }
      return pr;
    });
    const added: MergedPull[] = [];
    for (const found of merged) {
      // By the page the project knows it by (a renamed repository's old one, where it has that), so it's found where it is.
      const pr = { ...found, url: await knownUrl(prisma, projectId, found) };
      // Picked by the team: theirs to have in the changelog whatever Autopilot's gate said or says (their decision is kept).
      if (await addToRunningDraft(projectId, pr, undefined, { picked: pr })) {
        added.push(pr);
        // Taken out of an earlier draft with the line written for it (Autopilot's, or the team's edit of it): that line
        // again, not the pull request's title. Its record stays the one it was.
        const written = await prisma.codeChangeAction.findFirst({
          where: { codeChange: { projectId, repoId: pr.repoId, number: pr.number }, kind: "CHANGELOG_LINE", status: "APPLIED" },
          select: { payload: true },
        });
        const line = (written?.payload as { line?: unknown } | undefined)?.line;
        if (typeof line === "string" && line.trim() !== "") {
          await setChangelogLine(projectId, pr, line);
        }
      }
    }
    // Their code changes, there before this answers, and their analyses past the gate, one after another. Where jobs
    // run in this process (JOBS_DRIVER=inline) the analyses go on after the request has answered, as an import's pages
    // do: fifty of them would hold it for many minutes. Its line is in the draft either way; one that can't start is
    // said in the log, and the rest go on.
    const cantAnalyse = (pr: MergedPull) => (error: unknown) => {
      log.warn("A pull request added to the changelog couldn't be analysed", { projectId, repo: pr.repo, number: pr.number, error });
      return null;
    };
    const claims: { pr: MergedPull; claimed: NonNullable<Awaited<ReturnType<typeof claimCodeChange>>> }[] = [];
    for (const pr of added) {
      const claimed = await claimCodeChange(projectId, pr, { pastGate: true }).catch(cantAnalyse(pr));
      if (claimed?.run) {
        claims.push({ pr, claimed });
      }
    }
    const analysing = (async () => {
      for (const { pr, claimed } of claims) {
        // Skipped where its claim no longer holds (analysed meanwhile, by "Analyse anyway" say): see queueClaimed.
        await queueClaimed(claimed, enqueue).catch(cantAnalyse(pr));
      }
    })();
    if (process.env.JOBS_DRIVER !== "inline") {
      await analysing;
    } else {
      inBackground.add(analysing);
      void analysing.finally(() => inBackground.delete(analysing));
    }
    const draft = await prisma.changelogEntry.findFirst({ where: { projectId, collecting: true }, select: { number: true } });
    const ref = ({ repo, number }: { repo: string; number: number }) => ({ repo, number });
    const isAdded = (pr: MergedPull) => added.some((each) => each.repoId === pr.repoId && each.number === pr.number);
    return { number: draft?.number ?? null, added: added.map(ref), alreadyIn: merged.filter((pr) => !isAdded(pr)).map(ref) };
  },
});

/**
 * With AI credits on and Autopilot analysing, what "Add changes…" says each pull request added costs: `each`, its
 * deciding and writing as Settings → AI models prices them (typical sizes at the models' prices; null where the endpoint
 * didn't say them), and the balance. Null with credits off or nothing analysed (adding costs nothing then).
 */
export async function addedAnalysisCost(projectId: string): Promise<{ each: number | null; balance: number } | null> {
  if (!creditsEnabled() || !(await analysisOn(projectId))) {
    return null;
  }
  const listed = new Map((await listModels().catch(() => [])).map((model) => [model.id, model]));
  const models = await aiModels(projectId, listed);
  const parts = (["code_changes_decide", "code_changes"] as const).map((role) => costPerUse(role, listed.get(models[role].used)));
  const dollars = parts.every((part) => part !== null) ? parts.reduce((sum, part) => sum + part!.dollars, 0) : null;
  return { each: dollars === null ? null : dollars * creditsPerUsageDollar(), balance: (await creditBalance(projectId)).balance };
}

/**
 * What the pull request on this page of an entry's is, to keep the team's decision on (GitHub's id for its repository,
 * when it merged): its code change's or an earlier decision's word, else GitHub's. Null where it isn't known (GitHub
 * not connected, or the repository no longer included).
 */
async function pullRequestAt(projectId: string, url: string, ref: { repo: string; number: number }): Promise<MergedPull | null> {
  const select = { repoId: true, repo: true, number: true, title: true, author: true, mergedAt: true };
  const known = (await prisma.codeChange.findFirst({ where: { projectId, url }, select })) ?? (await prisma.changelogDecision.findFirst({ where: { projectId, url }, select }));
  if (known) {
    return { ...known, url, mergedAt: known.mergedAt.toISOString() };
  }
  const [read] = (await fromGithub(projectId, () => mergedPullRequestsByRef(projectId, [ref]))) ?? [];
  return typeof read === "object" ? { ...read, url } : null;
}

export const removeChangelogPullRequest = defineOperation({
  name: "changelog.removePullRequest",
  title: "Take a pull request out",
  summary:
    "Take a merged pull request out of a draft entry, with its line while that's still a bullet linking to it: it ships later, or isn't for readers. It can be added to the next entry (changelog.addPullRequests). A published entry's stay (a 409)",
  method: "POST",
  path: "/changelog/{number}/pull-requests/remove",
  scope: "write",
  access: "team",
  errors: [409, 502],
  input: z.object({
    number: entryNumber,
    url: z.string().trim().min(1).max(2048).describe("The pull request's page, as the entry's `pullRequests` gives it").meta({ examples: ["https://github.com/acme/app/pull/418"] }),
  }),
  output: entryOutput.describe("The entry, without it"),
  example: { url: "https://github.com/acme/app/pull/418" },
  run: async ({ projectId }, { number, url }) => {
    const portal = await projectPortal(projectId);
    const entry = await teamEntry(projectId, number);
    const row = entry.publishedAt ? null : await prisma.changelogEntryPullRequest.findUnique({ where: { entryId_url: { entryId: entry.id, url } }, select: { repo: true, number: true } });
    const done = await removePullRequest(projectId, entry.id, url, row && (await pullRequestAt(projectId, url, row)));
    if (done === "published") {
      throw new OperationError(409, "published", "Unpublish the entry to change its pull requests");
    }
    if (done === "missing") {
      throw new OperationError(404, "not_found", "This entry has no such pull request");
    }
    return entryView(await teamEntry(projectId, number), portal);
  },
});

export const MAX_TONE_LENGTH = 4000;
export const MAX_STYLE_EXAMPLES = 3;

/** The team's tone notes and example entries (the ones still published, in the order picked), and their cover defaults. */
async function changelogStyle(projectId: string) {
  const { changelogTone, changelogExampleIds, changelogScreenshotMarkers, changelogCoverDesign, changelogCoverBackground } = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      changelogTone: true,
      changelogExampleIds: true,
      changelogScreenshotMarkers: true,
      changelogCoverDesign: true,
      changelogCoverBackground: { select: { id: true, status: true, width: true, height: true } },
    },
  });
  const entries = await prisma.changelogEntry.findMany({
    where: { projectId, id: { in: changelogExampleIds }, publishedAt: { not: null } },
    select: { id: true, number: true, title: true, body: true, content: true },
  });
  return {
    tone: changelogTone,
    examples: changelogExampleIds.flatMap((id) => entries.filter((entry) => entry.id === id)),
    screenshotMarkers: changelogScreenshotMarkers,
    coverDesign: (COVER_DESIGNS as readonly string[]).includes(changelogCoverDesign) ? (changelogCoverDesign as CoverDesign) : "",
    coverBackground: lastingImage(changelogCoverBackground),
  };
}

/**
 * What AI writes like (releaseNotesPrompt, rewritePrompt): the tone notes, and the examples as Markdown, so their
 * headings and lists show as the reply's own do (without their images). With none picked, the project's latest
 * published entries: its own, so not Home's samples, and not the entry being written.
 */
async function writingStyle(projectId: string, entryId: string) {
  const { tone, examples, screenshotMarkers } = await changelogStyle(projectId);
  const entries =
    examples.length > 0
      ? examples
      : await prisma.changelogEntry.findMany({
          where: { projectId, publishedAt: { not: null }, sample: false, id: { not: entryId } },
          orderBy: [{ publishedAt: "desc" }, { number: "desc" }],
          take: MAX_STYLE_EXAMPLES,
          select: { title: true, body: true, content: true },
        });
  return { tone, examples: entries.map((entry) => ({ title: entry.title, markdown: toMarkdown(displayDoc(entry)) })), screenshotMarkers };
}

const COVER_DESIGN_LINE =
  "The cover design picked first when an entry's cover is made without one named (changelog.composeCover's `auto`, the Publish dialog), where the entry has what it needs; empty for the automatic pick";
const COVER_BACKGROUND_LINE = "The team's own image, for the `background` cover design";

const styleOutput = z
  .object({
    tone: z.string().describe("Notes on the tone to write in").meta({ examples: ["Friendly, short sentences, no jargon. Address the reader as you."] }),
    examples: z
      .array(
        z.object({
          number: z.number().int().describe("The entry's number").meta({ examples: [3] }),
          title: z.string().describe("Its title").meta({ examples: ["Faster search"] }),
        }),
      )
      .describe("Published entries to write like, in the order picked"),
    screenshotMarkers: z
      .boolean()
      .describe("AI drafts mark where a screenshot belongs with a line \"[Screenshot: what it should show]\", to replace with the picture before publishing")
      .meta({ examples: [false] }),
    coverDesign: z
      .enum(["", ...COVER_DESIGNS])
      .describe(COVER_DESIGN_LINE)
      .meta({ examples: [""] }),
    coverBackground: imageOutput.nullable().describe(COVER_BACKGROUND_LINE),
  })
  .meta({ id: "ChangelogStyle", description: "The changelog's writing style (the tone notes and example entries AI drafts follow) and its cover defaults" });

const styleView = ({ tone, examples, screenshotMarkers, coverDesign, coverBackground }: Awaited<ReturnType<typeof changelogStyle>>) => ({
  tone,
  examples: examples.map(({ number, title }) => ({ number, title })),
  screenshotMarkers,
  coverDesign,
  coverBackground,
});

export const getChangelogStyle = defineOperation({
  name: "changelogStyle.get",
  title: "Get the writing style",
  summary: "Get the changelog's writing style (the tone notes and example entries AI drafts follow) and its cover defaults",
  method: "GET",
  path: "/changelog-style",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: styleOutput.describe("The writing style"),
  run: async ({ projectId }) => styleView(await changelogStyle(projectId)),
});

export const updateChangelogStyle = defineOperation({
  name: "changelogStyle.update",
  title: "Update the writing style",
  summary: "Set the changelog's writing style for AI drafts (tone notes and example entries) and its cover defaults. What's left out stays as it is",
  method: "PATCH",
  path: "/changelog-style",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({
    tone: z
      .string()
      .trim()
      .max(MAX_TONE_LENGTH, "Keep the tone notes under 4,000 characters")
      .optional()
      .describe("Notes on the tone to write in, under 4,000 characters")
      .meta({ examples: ["Friendly, short sentences, no jargon. Address the reader as you."] }),
    examples: z
      .array(entryNumber)
      .max(MAX_STYLE_EXAMPLES, `Pick up to ${MAX_STYLE_EXAMPLES} examples`)
      .optional()
      .describe(`Up to ${MAX_STYLE_EXAMPLES} published entries to write like, by number: replaces the list`)
      .meta({ examples: [[3]] }),
    screenshotMarkers: z
      .boolean()
      .optional()
      .describe("Whether AI drafts mark where a screenshot belongs (\"[Screenshot: what it should show]\"); an entry with a marker left can't be published")
      .meta({ examples: [true] }),
    coverDesign: z
      .enum(["", ...COVER_DESIGNS])
      .optional()
      .describe(COVER_DESIGN_LINE)
      .meta({ examples: ["pattern"] }),
    coverBackground: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(`${COVER_BACKGROUND_LINE}: the id of one of the images uploaded in the app, null to remove`)
      .meta({ examples: [null] }),
  }),
  output: styleOutput.describe("The writing style now"),
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
    await saving(() =>
      prisma.$transaction(async (tx) => {
        // A new background is this project's finished image (a 409 otherwise), attached before the project points at it. The
        // one it replaces is released by release-media once nothing uses it.
        await attachCover(tx, projectId, input.coverBackground);
        await tx.project.update({
          where: { id: projectId },
          data: {
            ...(input.tone !== undefined && { changelogTone: input.tone }),
            ...(input.screenshotMarkers !== undefined && { changelogScreenshotMarkers: input.screenshotMarkers }),
            ...(exampleIds && { changelogExampleIds: exampleIds }),
            ...(input.coverDesign !== undefined && { changelogCoverDesign: input.coverDesign }),
            ...(input.coverBackground !== undefined && { changelogCoverBackgroundId: input.coverBackground }),
          },
        });
      }),
    );
    return styleView(await changelogStyle(projectId));
  },
});

export const publishChangelogEntry = defineOperation({
  name: "changelog.publish",
  title: "Publish a changelog entry",
  summary:
    "Publish a changelog entry on the portal; the posts it completes become Completed. Sample entries (Home's sample content) are always published quietly and never emailed; so, the first time, is one imported as a draft though published in the other tool, and it keeps its date there.",
  method: "POST",
  path: "/changelog/{number}/publish",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    number: entryNumber,
    announce: z
      .boolean()
      .default(true)
      .describe("Announced (the default), it shows as new in the widget; false publishes it quietly")
      .meta({ examples: [true] }),
    emailSubscribers: z
      .boolean()
      .default(false)
      .describe("Email it to the changelog's confirmed subscribers (a public portal's): the first time it's published that way only")
      .meta({ examples: [true] }),
  }),
  output: entryOutput.describe("The entry, published"),
  example: { announce: true, emailSubscribers: true },
  run: async ({ actor, projectId }, { number, announce, emailSubscribers }) => {
    const entry = await teamEntry(projectId, number);
    const slug = await projectSlug(projectId);
    const portal = await portalAddress(slug);
    // One transaction: published, its posts completed (and due for their shipped
    // emails), and the webhook deliveries saved. Sending happens after it commits.
    const shipped = await prisma.$transaction(async (tx) => {
      // After any merge being added to this (running) draft, and before the next (see lockProject).
      await lockProject(tx, projectId);
      // Sample content (server/sample-content.ts) is never announced, and reaches no webhooks; nor do sample posts it completes.
      // Its text as it is now, held until this commits (a save made meanwhile waits, then finds it published): what a
      // draft left for the team to fill in ("[Check: …]", "[Screenshot: …]") doesn't go out to readers, or by email,
      // which can't be taken back.
      await tx.$queryRaw`SELECT 1 FROM changelog_entry WHERE id = ${entry.id} FOR UPDATE`;
      const { sample, importedPublishedAt, publishedAt, ...text } = await tx.changelogEntry.findUniqueOrThrow({
        where: { id: entry.id },
        select: { sample: true, importedPublishedAt: true, publishedAt: true, body: true, content: true },
      });
      const markers = publishedAt ? [] : markersIn(displayDoc(text));
      if (markers.length > 0) {
        throw new OperationError(409, "markers", `Replace or remove ${markers.length === 1 ? "the marker" : `the ${markers.length} markers`} in its text first: ${markers.join(" ")}`);
      }
      // Published in the tool it was imported from: old news, so it keeps that date and isn't announced or emailed.
      const quiet = sample || importedPublishedAt !== null;
      // Only the first publish counts (a repeated call changes nothing).
      const { count } = await tx.changelogEntry.updateMany({
        where: { id: entry.id, publishedAt: null },
        // Published by hand, it stops collecting: the next merge starts a new draft.
        // Its release's notes are written: it no longer waits on the list ("Next release is ready to write").
        data: { publishedAt: importedPublishedAt ?? new Date(), importedPublishedAt: null, collecting: false, releasedAt: null, announced: announce && !quiet },
      });
      if (count === 0) {
        return null;
      }
      // Emailed to subscribers once per entry: never again when it's unpublished and published again. Only from a
      // public portal (a private one's subscribers may not be its readers: changelogEmailed sends nothing there), and
      // never a sample entry (Home's sample content is for the team to try things with) or a quiet imported one.
      const { portalAccess } = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true } });
      if (emailSubscribers && portalAccess === "PUBLIC" && !quiet) {
        await tx.changelogEntry.updateMany({ where: { id: entry.id, subscribersEmailedAt: null }, data: { subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date() } });
      }
      // Due now, or still from a publish before (unpublished before they all went): they go now, due from now, so the
      // cron (which looks back two days) covers them again if queueing or the job fails.
      const emailing =
        (await tx.changelogEntry.updateMany({ where: { id: entry.id, subscribersEmailDueAt: { not: null } }, data: { subscribersEmailDueAt: new Date() } }))
          .count === 1;
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
        const [current] = await tx.$queryRaw<{ status: PostStatus; sample: boolean; seen: PostVisibility }[]>`
          SELECT status, sample, ${SEEN_AS_SQL} AS seen FROM post WHERE id = ${postId} FOR UPDATE`;
        // A sample entry completes sample posts only, and a real one real posts only, however one got linked (changelog.update refuses them).
        if (!current || sample !== current.sample || current.status === "COMPLETED" || current.status === "CLOSED") {
          continue;
        }
        await tx.post.update({ where: { id: postId }, data: { status: "COMPLETED", ...(!current.sample && { shippedEmailsDueAt: current.seen === "TEAM" ? null : new Date() }) } });
        // Its shipped emails are counted on this event: the entry's "told" (entryTold).
        await tx.postEvent.create({
          data: { postId, actorId: actor.kind === "user" ? actor.userId : actor.createdById, from: current.status, to: "COMPLETED", changelogEntryId: entry.id },
        });
        if (current.sample) {
          continue;
        }
        const updated = await tx.post.findUniqueOrThrow({ where: { id: postId }, select: postSummarySelect });
        deliveries.push(
          ...(await recordEvent(tx, projectId, "post.status_changed", {
            post: postSummary(updated, portal),
            previousStatus: toApiStatus(current.status),
          })),
        );
        completed.push(postId);
      }
      const published = await tx.changelogEntry.findUniqueOrThrow({ where: { id: entry.id }, select: entrySelect });
      // Counts read in the transaction, on its connection (a second one could wait on the pool).
      const counts = await reactionCounts([published.id], tx);
      if (!sample) {
        deliveries.push(...(await recordEvent(tx, projectId, "changelog.published", await entryView(published, portal, counts))));
      }
      return { deliveries, completed, emailing };
    });
    if (shipped) {
      // Anything not queued now is picked up by the webhook-resubmit, shipped-emails-resubmit and changelog-emails-resubmit jobs.
      await queueDeliveries(shipped.deliveries);
      for (const postId of shipped.completed) {
        try {
          await enqueue("postShipped", { postId });
        } catch (error) {
          log.warn("Couldn't queue a post's shipped emails", { postId, error });
        }
      }
      if (shipped.emailing) {
        try {
          await enqueue("changelogEmailed", { entryId: entry.id });
        } catch (error) {
          log.warn("Couldn't queue a changelog entry's emails to subscribers", { entryId: entry.id, error });
        }
      }
    }
    return entryView(await teamEntry(projectId, number), portal);
  },
});

export const unpublishChangelogEntry = defineOperation({
  name: "changelog.unpublish",
  title: "Unpublish a changelog entry",
  summary: "Take a changelog entry off the portal, back to a draft; the posts it completed keep their status",
  method: "POST",
  path: "/changelog/{number}/unpublish",
  scope: "write",
  access: "team",
  input: z.object({ number: entryNumber }),
  output: entryOutput.describe("The entry, a draft again"),
  run: async ({ projectId }, { number }) => {
    const portal = await projectPortal(projectId);
    const entry = await teamEntry(projectId, number);
    // Only a published one: its notes were written, so it doesn't wait on the list again, even if the release that
    // published it (an older one, during a deploy) left `releasedAt` set. A draft (say, one a release closed) keeps it.
    // Published once (by a release that didn't know an imported date, say), it's no longer old news: that date goes too.
    await prisma.changelogEntry.updateMany({ where: { id: entry.id, publishedAt: { not: null } }, data: { publishedAt: null, releasedAt: null, importedPublishedAt: null } });
    return entryView(await teamEntry(projectId, number), portal);
  },
});

export const deleteChangelogEntry = defineOperation({
  name: "changelog.delete",
  title: "Delete a changelog entry",
  summary: "Delete a changelog entry, for good",
  method: "DELETE",
  path: "/changelog/{number}",
  scope: "write",
  access: "team",
  input: z.object({ number: entryNumber }),
  output: z.object({ deleted: z.number().int().describe("The deleted entry's number").meta({ examples: [7] }) }).describe("What was deleted"),
  run: async ({ projectId }, { number }) => {
    const entry = await teamEntry(projectId, number);
    await prisma.changelogEntry.delete({ where: { id: entry.id } });
    return { deleted: number };
  },
});
