import { type HtmlContent, htmlToContent, type LeftOut, type LeftOutReason, type MediaImporter } from "@tuti/content/html";
import { imageKey, imageWidths } from "@tuti/content/media";
import { type PostStatus, type Prisma, prisma } from "@tuti/db";
import { boardLimit, embeddingsEnabled } from "@tuti/shared";
import { titleSlug } from "@tuti/shared/post-urls";
import { mediaStorage } from "@tuti/shared/storage";

import { embedPosts } from "./duplicates";
import type { FeaturebaseAuthor, FeaturebaseBoard, FeaturebaseComment, FeaturebaseLocalized, FeaturebasePost, FeaturebaseVoter } from "./featurebase";
import { mediaImporter } from "./import-media";
import { adminMember, contactUsers, type ImportJob, loadAdmins, type StepPage, tally } from "./imports";
import { lastingMediaUrl } from "./lasting-media";
import { syncUsersIn } from "./project-users";

/**
 * Feedback from Featurebase (docs/plan.md, Switching from Featurebase, I3): boards, posts, votes and comments, written
 * straight to the database as sample content is (server/sample-content.ts), so nothing is emailed, queued or sent to
 * webhooks, with their original dates. What only some people see in Featurebase stays out, counted. Then contacts'
 * avatars are copied, and the posts embedded for duplicates.
 */

type Tx = Prisma.TransactionClient;
const NOTHING: StepPage["save"] = async () => {};

/** What the project's imports from this source made of these Featurebase ids (`kind`: board, post, comment). */
async function recorded(db: Tx, job: ImportJob, kind: string, externalIds: string[]): Promise<Map<string, string>> {
  const rows = await db.importedRecord.findMany({ where: { projectId: job.projectId, source: job.source, kind, externalId: { in: externalIds } }, select: { externalId: true, localId: true } });
  return new Map(rows.map((row) => [row.externalId, row.localId]));
}

const remember = (tx: Tx, job: ImportJob, kind: string, externalId: string, localId: string) =>
  tx.importedRecord.create({ data: { projectId: job.projectId, source: job.source, kind, externalId, localId } });

/** Images, files and videos the content left out, and what it copied, counted (`profile`'s rules say why). */
function countMedia(job: ImportJob, content: HtmlContent, profile: "post" | "comment") {
  tally(job.counts, "images", null, content.mediaIds.length);
  content.leftOut.forEach((item: LeftOut) => tally(job.counts, `${item.kind}s`, mediaReason(item.reason, profile)));
}

/** Why an image (or avatar) was left out, after "2 images …". */
function mediaReason(reason: LeftOutReason, profile?: "post" | "comment"): string {
  if (reason === "unsupported") {
    return profile === "comment" ? "in comments, which have none in Tuti" : mediaStorage() ? "Tuti has no place for" : "with no media storage on this server";
  }
  return { type: "of a type Tuti doesn't take", size: "over the upload limit", quota: "past the project's media quota", unreachable: "that couldn't be fetched" }[reason];
}

/** The page's media importer, its copies kept for the page (null once the person who started it is gone). */
const importer = (job: ImportJob): MediaImporter | undefined => (job.startedById ? mediaImporter({ projectId: job.projectId, uploaderId: job.startedById }) : undefined);

// Boards

/** Seen by only some people in Featurebase (admins, some roles, a segment): left out, with their posts. */
const restricted = (board: FeaturebaseBoard) => Boolean(board.access?.adminOnly || board.access?.allowedRoles?.length || board.access?.segments?.length);

/** As apps/web lib/board-texts.ts BOARD_TEXT_LIMITS, and the board form's description. */
const LIMITS = { description: 280, postButton: 30, detailsPlaceholder: 120 };

/** A board's words in the locale its name is in (else the first one), those that fit Tuti's. */
function boardWords(board: FeaturebaseBoard) {
  const words = board.localization ?? {};
  const locale = Object.entries(words.name ?? {}).find(([, name]) => name === board.name)?.[0];
  const pick = (field: FeaturebaseLocalized | undefined, max: number) => {
    const value = (field && ((locale && field[locale]) || Object.values(field)[0]))?.trim();
    return value && value.length <= max ? value : undefined;
  };
  return {
    description: pick(words.description, LIMITS.description),
    postButton: pick(words.submitButtonText, LIMITS.postButton),
    detailsPlaceholder: pick(words.formPlaceholder, LIMITS.detailsPlaceholder),
  };
}

/**
 * The project's board for each Featurebase board everyone sees: one of the same name (a new project's Feature requests),
 * else a new one while the plan has room (boardLimit), else the last one imported, which takes its posts. Remembered,
 * so every page (and a later import) puts them in the same place. `count`: counted (the step's first page).
 */
async function importBoards(tx: Tx, job: ImportJob, boards: FeaturebaseBoard[], count: boolean): Promise<Map<string, string>> {
  const visible = boards.filter((board) => !restricted(board));
  const known = await recorded(tx, job, "board", visible.map((board) => board.id));
  const existing = await tx.board.findMany({ where: { projectId: job.projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true, slug: true } });
  const { plan } = await tx.project.findUniqueOrThrow({ where: { id: job.projectId }, select: { plan: true } });
  const limit = boardLimit(plan);
  const used = new Set<string>();
  let last: string | undefined;
  for (const board of visible) {
    let id = known.get(board.id);
    // One deleted since is made again.
    if (!id || !existing.some((b) => b.id === id)) {
      await tx.importedRecord.deleteMany({ where: { projectId: job.projectId, source: job.source, kind: "board", externalId: board.id } });
      const name = board.name.trim().slice(0, 60) || "Feedback";
      const same = existing.find((b) => b.name.trim().toLowerCase() === name.toLowerCase());
      const words = boardWords(board);
      if (same) {
        id = same.id;
        await tx.board.update({ where: { id }, data: words });
      } else if (limit === null || existing.length < limit) {
        const slugged = titleSlug(name, "board").slice(0, 36).replace(/-+$/, "");
        const base = slugged.length >= 2 ? slugged : "board";
        let slug = base;
        for (let n = 2; existing.some((b) => b.slug === slug); n++) {
          slug = `${base}-${n}`;
        }
        // As a board made in the app: taking a slug that redirected to another board ends that redirect.
        await tx.boardRedirect.deleteMany({ where: { projectId: job.projectId, slug } });
        const created = await tx.board.create({ data: { projectId: job.projectId, name, slug, ...words }, select: { id: true, name: true, slug: true } });
        existing.push(created);
        id = created.id;
      } else {
        id = last ?? existing.at(-1)!.id;
      }
      await remember(tx, job, "board", board.id, id);
    }
    known.set(board.id, id);
    if (count) {
      tally(job.counts, "boards", used.has(id) ? "past the plan's board limit, their posts in the last board" : null);
    }
    used.add(id);
    last = id;
  }
  if (count) {
    tally(job.counts, "boards", "only some people see", boards.length - visible.length);
  }
  return known;
}

// Posts

/** Tuti's statuses by their names, and by Featurebase's types for its own names. */
const STATUS_NAMES: Record<string, PostStatus> = { open: "OPEN", "under review": "UNDER_REVIEW", planned: "PLANNED", "in progress": "IN_PROGRESS", completed: "COMPLETED", closed: "CLOSED" };
const STATUS_TYPES: Record<string, PostStatus> = { reviewing: "UNDER_REVIEW", unstarted: "PLANNED", active: "IN_PROGRESS", completed: "COMPLETED", canceled: "CLOSED" };
export const postStatus = (status: FeaturebasePost["status"] | null) =>
  STATUS_NAMES[status?.name?.trim().toLowerCase() ?? ""] ?? STATUS_TYPES[status?.type ?? ""] ?? "OPEN";

/** A date Featurebase gave, else `fallback`. */
const dateOf = (value: string | null | undefined, fallback: Date) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : fallback;
};

/** Tuti keeps an ETA as its month (the first day, UTC). */
function etaMonth(eta: string | null): Date | null {
  const date = eta ? new Date(eta) : null;
  return date && !Number.isNaN(date.getTime()) ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)) : null;
}

/** Why a post stays out (null: it comes), its board's too. */
function postLeftOut(post: FeaturebasePost, boards: Map<string, FeaturebaseBoard>): string | null {
  const board = boards.get(post.boardId);
  if (!board || restricted(board) || post.access?.userIds?.length || post.access?.companyExternalIds?.length) {
    return "only some people see";
  }
  return post.portalHidden ? "hidden from the portal" : post.inReview ? "waiting for moderation" : null;
}

/** The contacts among authors and voters, read before the page's transaction (contactUsers); admins' too (loadAdmins). */
async function people(job: ImportJob, authors: (FeaturebaseAuthor | FeaturebaseVoter)[]) {
  if (authors.some((author) => author?.type === "admin")) {
    await loadAdmins(job);
  }
  return contactUsers(job, authors.flatMap((author) => (author?.id && (author.type === "customer" || author.type === "lead") ? [author.id] : [])));
}

/**
 * Who wrote something here: an admin the team member with their address, else their placeholder (adminMember); a
 * contact their user; anyone else (a guest, a bot, a contact Featurebase no longer has) a user of the project's
 * under their name, as a lead without an id of their own is (`featurebase:<id>`).
 */
async function authorOf(tx: Tx, job: ImportJob, author: FeaturebaseAuthor, contacts: Map<string, string>): Promise<string> {
  if (author?.id && author.type === "admin") {
    return (await adminMember(tx, job, author.id, author)).userId;
  }
  const contact = author?.id && contacts.get(author.id);
  if (contact) {
    return contact;
  }
  const externalId = `featurebase:${author?.id ?? "anonymous"}`;
  const { userIds } = await syncUsersIn(tx, job.projectId, [{ externalId, name: author?.name?.trim() || "Anonymous" }]);
  return userIds.get(externalId)!;
}

/**
 * Posts, a page at a time in date order (numbered so), with their boards: content (images copied first, outside the
 * lock), author, date, status (with its event, as sample content writes one) and ETA, and the author's vote, as Tuti
 * gives every author (Featurebase counts it among the voters too). Merged posts aren't listed: Featurebase moved their
 * votes and comments already.
 */
async function postsPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const boards = await job.featurebase.get<FeaturebaseBoard[]>("/boards");
  const { items, next } = await job.featurebase.page<FeaturebasePost>("/posts", cursor, { sortBy: "createdAt", sortOrder: "asc" });
  const byId = new Map(boards.map((board) => [board.id, board]));
  const known = await recorded(prisma, job, "post", items.map((post) => post.id));
  const fresh = items.filter((post) => !known.has(post.id) && !postLeftOut(post, byId));
  const media = importer(job);
  const contents = new Map<string, HtmlContent | { error: string }>();
  for (const post of fresh) {
    contents.set(post.id, await htmlToContent("post", post.content ?? "", { media }));
  }
  const contacts = await people(job, fresh.map((post) => post.author));
  return {
    next,
    save: async (tx) => {
      const boardIds = await importBoards(tx, job, boards, cursor === null);
      const users = await contacts.save(tx);
      const saved = await recorded(tx, job, "post", items.map((post) => post.id));
      for (const post of items) {
        const leftOut = postLeftOut(post, byId);
        const content = contents.get(post.id);
        if (leftOut || (content && "error" in content)) {
          tally(job.counts, "posts", leftOut ?? "whose content couldn't be read");
          continue;
        }
        if (saved.has(post.id) || !content) {
          tally(job.counts, "posts", null);
          continue;
        }
        const authorId = await authorOf(tx, job, post.author, users);
        const { postCount: number } = await tx.project.update({ where: { id: job.projectId }, data: { postCount: { increment: 1 } }, select: { postCount: true } });
        const createdAt = dateOf(post.createdAt, new Date());
        const updatedAt = dateOf(post.updatedAt, createdAt);
        const status = postStatus(post.status);
        const created = await tx.post.create({
          data: {
            projectId: job.projectId,
            boardId: boardIds.get(post.boardId)!,
            authorId,
            number,
            title: (post.title ?? "").trim().slice(0, 120) || "Untitled",
            body: content.text,
            content: content.doc,
            status,
            eta: etaMonth(post.eta),
            voteCount: 1,
            votes: { create: { userId: authorId, projectId: job.projectId, createdAt } },
            createdAt,
            updatedAt,
            ...(status !== "OPEN" && { events: { create: { from: "OPEN", to: status, createdAt: updatedAt } } }),
          },
          select: { id: true },
        });
        await remember(tx, job, "post", post.id, created.id);
        tally(job.counts, "posts", null);
        countMedia(job, content, "post");
      }
    },
  };
}

// Votes

/** Where the votes step got to: the post (by Featurebase id, in that order) and its voters' cursor. */
type VotesAt = { post: string; voters: string | null };
/** A page reads at most this many posts' voters, in at most this many requests. */
const VOTE_POSTS = 50;
const VOTE_REQUESTS = 10;

/** Counts the votes and comments of these posts again, from what they have. */
async function recount(tx: Tx, postIds: string[]) {
  await tx.$executeRaw`
    UPDATE post SET "voteCount" = (SELECT count(*) FROM vote WHERE "postId" = post.id), "commentCount" = (SELECT count(*) FROM comment WHERE "postId" = post.id)
    WHERE id = ANY(${[...new Set(postIds)]}::text[])`;
}

/**
 * Voters as votes, a few posts at a time (those imported, in Featurebase's id order; a post with many voters over
 * several pages). Featurebase keeps no vote's date: a vote is dated by the post, or the voter's joining if later.
 * voteCount is counted from the votes, the author's own among them.
 */
async function votesPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const at = cursor ? (JSON.parse(cursor) as VotesAt) : null;
  const posts = await prisma.importedRecord.findMany({
    where: { projectId: job.projectId, source: job.source, kind: "post", ...(at && { externalId: { gte: at.post } }) },
    orderBy: { externalId: "asc" },
    take: VOTE_POSTS + 1,
    select: { externalId: true, localId: true },
  });
  const read: { postId: string; voters: FeaturebaseVoter[] }[] = [];
  let next: VotesAt | null = posts.length > VOTE_POSTS ? { post: posts[VOTE_POSTS]!.externalId, voters: null } : null;
  let requests = 0;
  for (const post of posts.slice(0, VOTE_POSTS)) {
    let voters = at?.post === post.externalId ? at.voters : null;
    if (requests === VOTE_REQUESTS) {
      next = { post: post.externalId, voters };
      break;
    }
    do {
      const page = await job.featurebase.page<FeaturebaseVoter>(`/posts/${encodeURIComponent(post.externalId)}/voters`, voters);
      requests++;
      read.push({ postId: post.localId, voters: page.items });
      voters = page.next;
    } while (voters && requests < VOTE_REQUESTS);
    if (voters) {
      next = { post: post.externalId, voters };
      break;
    }
  }
  const contacts = await people(job, read.flatMap((page) => page.voters));
  return {
    next: next && JSON.stringify(next),
    save: async (tx) => {
      const users = await contacts.save(tx);
      const dates = new Map((await tx.post.findMany({ where: { projectId: job.projectId, id: { in: read.map((page) => page.postId) } }, select: { id: true, createdAt: true } })).map((post) => [post.id, post.createdAt]));
      const votes: Prisma.VoteCreateManyInput[] = [];
      for (const { postId, voters } of read) {
        const posted = dates.get(postId);
        for (const voter of posted ? voters : []) {
          const userId =
            voter.type === "admin" ? (await adminMember(tx, job, voter.id, voter)).userId : voter.type === "customer" || voter.type === "lead" ? users.get(voter.id) : undefined;
          if (!userId) {
            tally(job.counts, "votes", voter.type === "customer" || voter.type === "lead" ? "by people Featurebase no longer has" : "by guests");
            continue;
          }
          const joined = dateOf(voter.createdAt, posted!);
          votes.push({ postId, userId, projectId: job.projectId, createdAt: joined > posted! ? joined : posted! });
          tally(job.counts, "votes", null);
        }
      }
      await tx.vote.createMany({ data: votes, skipDuplicates: true });
      await recount(tx, [...dates.keys()]);
    },
  };
}

// Comments

/** Why a comment stays out (null: it comes). A private one is the team's note: only by the team. */
function commentLeftOut(comment: FeaturebaseComment, posts: Map<string, string>): string | null {
  if (comment.isDeleted || comment.isSpam) {
    return "deleted or spam";
  }
  if (comment.inReview) {
    return "waiting for moderation";
  }
  if (!posts.has(comment.postId!)) {
    return "on posts left out";
  }
  return comment.isPrivate && !(comment.author?.type === "admin" && comment.author.id) ? "private but not by the team" : null;
}

/**
 * Comments, every one at once in date order (a changelog's left alone), joined to their posts by the record map:
 * public ones as comments (flat: a reply follows its thread in time), private ones by the team as internal notes.
 * Tuti's comments have no images, so theirs are left out and counted. commentCount is counted from them.
 */
async function commentsPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const page = await job.featurebase.page<FeaturebaseComment>("/comments", cursor, { privacy: "all", sortBy: "old" });
  const items = page.items.filter((comment) => comment.postId);
  const posts = await recorded(prisma, job, "post", items.map((comment) => comment.postId!));
  const known = await recorded(prisma, job, "comment", items.map((comment) => comment.id));
  const fresh = items.filter((comment) => !known.has(comment.id) && !commentLeftOut(comment, posts));
  const contents = new Map<string, HtmlContent | { error: string }>();
  for (const comment of fresh) {
    contents.set(comment.id, await htmlToContent("comment", comment.content ?? ""));
  }
  const contacts = await people(job, fresh.map((comment) => comment.author));
  return {
    next: page.next,
    save: async (tx) => {
      const users = await contacts.save(tx);
      const saved = await recorded(tx, job, "comment", items.map((comment) => comment.id));
      const live = new Set((await tx.post.findMany({ where: { projectId: job.projectId, id: { in: [...posts.values()] } }, select: { id: true } })).map((post) => post.id));
      const touched: string[] = [];
      for (const comment of items) {
        const kind = comment.isPrivate ? "notes" : "comments";
        const content = contents.get(comment.id);
        const postId = posts.get(comment.postId!);
        const leftOut = commentLeftOut(comment, posts) ?? (postId && !live.has(postId) ? "on posts left out" : null);
        if (leftOut || (content && ("error" in content || !content.text.trim()))) {
          tally(job.counts, "comments", leftOut ?? (content && "error" in content ? "whose content couldn't be read" : "with nothing left in them"));
          continue;
        }
        if (saved.has(comment.id) || !content) {
          tally(job.counts, kind, null);
          continue;
        }
        const createdAt = dateOf(comment.createdAt, new Date());
        const authorId = comment.isPrivate ? (await adminMember(tx, job, comment.author!.id!, comment.author!)).userId : await authorOf(tx, job, comment.author, users);
        const row = { postId: postId!, authorId, body: content.text, content: content.doc, createdAt };
        const created = comment.isPrivate
          ? await tx.postNote.create({ data: row, select: { id: true } })
          : await tx.comment.create({ data: { ...row, projectId: job.projectId, updatedAt: createdAt }, select: { id: true } });
        await remember(tx, job, "comment", comment.id, created.id);
        touched.push(postId!);
        tally(job.counts, kind, null);
        countMedia(job, content, "comment");
      }
      await recount(tx, touched);
    },
  };
}

// Avatars and embeddings

const AVATARS = 20;

/**
 * Contacts' uploaded avatars (those whose user still has the link the import gave them) copied into media storage and
 * pointed at, as Account's photo is (a lasting link to its smallest size); Featurebase's generated ones never came
 * across (contactDetails). One that can't be copied is left out, counted, and their initials show. Without media
 * storage, the links stay as they are.
 */
async function avatarsPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const media = importer(job);
  if (!media || !mediaStorage()) {
    return { next: null, save: NOTHING };
  }
  const users = await prisma.$queryRaw<{ id: string; image: string }[]>`
    SELECT u.id, u.image FROM imported_record r JOIN "user" u ON u.id = r."localId"
    WHERE r."projectId" = ${job.projectId} AND r.source = ${job.source}::"ImportSource" AND r.kind = 'contact'
      AND u."imageId" IS NULL AND u.image ~ '^https?://' AND u.id > ${cursor ?? ""}
    ORDER BY u.id LIMIT ${AVATARS}`;
  const copies: { user: (typeof users)[number]; copy: Awaited<ReturnType<MediaImporter>> }[] = [];
  for (const user of users) {
    copies.push({ user, copy: await media({ kind: "image", url: user.image, key: user.image }) });
  }
  return {
    next: users.length === AVATARS ? users.at(-1)!.id : null,
    save: async (tx) => {
      for (const { user, copy } of copies) {
        const width = "mediaId" in copy ? copy.width : null;
        const data = "mediaId" in copy && width ? { image: lastingMediaUrl(imageKey(copy.mediaId, imageWidths(width)[0]!)), imageId: copy.mediaId } : { image: null };
        // Unless their avatar changed meanwhile (an SSO sign-in).
        const { count } = await tx.user.updateMany({ where: { id: user.id, imageId: null, image: user.image }, data });
        if (count > 0) {
          tally(job.counts, "avatars", "leftOut" in copy ? mediaReason(copy.leftOut) : width ? null : mediaReason("type"));
        }
      }
    },
  };
}

/** The imported posts embedded for duplicates, as the post-created job would (without its other work), 100 at a time. */
async function embeddingsPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  if (!embeddingsEnabled()) {
    return { next: null, save: NOTHING };
  }
  const records = await prisma.importedRecord.findMany({
    where: { projectId: job.projectId, source: job.source, kind: "post", ...(cursor && { externalId: { gt: cursor } }) },
    orderBy: { externalId: "asc" },
    take: 100,
    select: { externalId: true, localId: true },
  });
  await embedPosts(await prisma.post.findMany({ where: { projectId: job.projectId, id: { in: records.map((record) => record.localId) } }, select: { id: true, projectId: true, title: true, body: true } }));
  return { next: records.length === 100 ? records.at(-1)!.externalId : null, save: NOTHING };
}

/** Feedback's steps, in order (@tuti/jobs IMPORT_PARTS). */
export const feedbackSteps = [
  { name: "posts", page: postsPage },
  { name: "votes", page: votesPage },
  { name: "comments", page: commentsPage },
  { name: "avatars", page: avatarsPage },
  { name: "embeddings", page: embeddingsPage },
];
