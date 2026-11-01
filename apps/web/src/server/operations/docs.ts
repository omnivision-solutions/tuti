import { isDeepStrictEqual } from "node:util";

import { type ArticleListing, type NoAccess, Prisma, prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS, enqueue, lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { type Listing, LISTINGS } from "@/lib/article-listing";
import { ancestry, height, MAX_COLLECTION_DEPTH } from "@/lib/collection-tree";
import { lucideIcon } from "@/lib/lucide-icons";
import { portalAddress } from "@/server/custom-domains";
import { titleSlug } from "@/lib/post-urls";
import { type Access, ACCESSES, fromNoAccess, fromReadAccess, type Level, NO_ACCESSES, toNoAccess, toReadAccess, type WithoutAccess } from "@/lib/read-access";
import { claimsOf, levelSelect, MAX_READER_GROUPS, readerGroup } from "@/lib/reader-groups";

import { attachMedia, displayDoc, readContent } from "../content";
import { inTreeOrder, listedArticle, readableArticle, readingOrder } from "../docs-queries";
import { searchDocs } from "../docs-search";
import { actorReader } from "../portal-access";
import { isTeam } from "./changelog";
import { saving } from "./create";
import { type Actor, defineOperation, OperationError } from "./define";
import { requirePlan } from "./plan";
import { projectSlug } from "./read";

/** The docs (Phase 10): articles the team writes, grouped in collections, published on the portal's /docs. */

export const MAX_ARTICLE_LENGTH = 50_000;
/**
 * Revisions kept per article; older ones go as new ones come. Every save is a deliberate click
 * (the editor doesn't autosave), so each is kept rather than merged with the last.
 */
export const ARTICLE_REVISIONS_KEPT = 50;

export const MAX_ARTICLE_TITLE = 120;
export const MAX_ARTICLE_DESCRIPTION = 300;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD = 60;

const toListing = (listing: Listing) => listing.toUpperCase() as ArticleListing;
/** Listings whose page and .md anyone may read (see servedArticle). */
const SERVED: ArticleListing[] = ["EVERYWHERE", "UNLISTED"];

const slug = z.string().trim().min(1).max(80);
const articleFields = {
  title: z.string().trim().min(3, "Title is too short").max(MAX_ARTICLE_TITLE),
  /** Plain text; ignored when `content` is sent. */
  body: z.string().max(MAX_ARTICLE_LENGTH).optional(),
  /** Rich content (the editor's JSON, "article" profile). */
  content: z.unknown().optional(),
  /** The collection's slug, or null for none. */
  collection: slug.nullable().optional(),
  /** Show "Updated <date>" on the portal when it's edited after it was published (default true). */
  showUpdatedDate: z.boolean().optional(),
  /**
   * Where it's served once published (default everywhere): `everywhere`; `unlisted` (readable at its
   * link, in no list or search; AI answers cite it); `hidden` (nowhere public); `ai_only` (only a
   * source for AI answers, named without a link).
   */
  listing: z.enum(LISTINGS).optional(),
  /** The meta description: under its title in search engines' results (up to 300 characters; empty: from the text). Changes at once. */
  description: z.string().trim().max(MAX_ARTICLE_DESCRIPTION, `The description is up to ${MAX_ARTICLE_DESCRIPTION} characters`).optional(),
  /**
   * Words readers search for that the text doesn't have (up to 20, of up to 60 characters; the same
   * word twice, in any case, is kept once): docs search matches them like the text, and AI answers
   * find the article by them. Replaces the ones it has; changes at once.
   */
  keywords: z
    .array(z.string().trim().min(1).max(MAX_KEYWORD, `Keywords are up to ${MAX_KEYWORD} characters`))
    .max(MAX_KEYWORDS, `Up to ${MAX_KEYWORDS} keywords`)
    .transform((keywords) => keywords.filter((k, i) => keywords.findIndex((other) => other.toLowerCase() === k.toLowerCase()) === i))
    .optional(),
  /** "Block search indexing": search engines are asked not to list it, and it's left out of the sitemap and llms.txt (readers still find it in the docs and their search). Changes at once. */
  noindex: z.boolean().optional(),
};

/** A slug the team picks for an article (see customDocsSlug). */
const customSlug = z
  .string()
  .trim()
  .min(1, "Enter a slug")
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and hyphens");

/** "Who can read" on tabs.*, collections.* and articles.* (see accessChange). */
const accessFields = {
  /**
   * Who may read it (and what's in it), on top of what's above it: `inherit` (what the level above
   * allows; for a tab, everyone who may read the portal), `signed_in` (anyone signed in on the
   * portal) or `groups` (readers in one of `groups`; with none, only the team). The team reads everything.
   */
  access: z.enum(ACCESSES).optional(),
  /**
   * With `access: "groups"`, the groups (keys: groups.list); left out, the ones it has. Without
   * `access`, groups alone set it: some make it `groups`, none `inherit` (as collections' `groups` did).
   */
  groups: z
    .array(readerGroup)
    .max(MAX_READER_GROUPS, `Up to ${MAX_READER_GROUPS} groups`)
    .transform((groups) => [...new Set(groups)])
    .optional(),
  /**
   * What people it isn't for see of it: `inherit` (the default: what the level above says; with
   * nothing above saying, `hide`), `lock` (its title, listed with a lock; its page asks them to sign
   * in or says they don't have access, never its content) or `hide` (nothing: not listed, and its
   * link is not found).
   */
  noAccess: z.enum(NO_ACCESSES).optional(),
};

/**
 * What an operation's `access`, `groups` and `noAccess` change (undefined: none was sent): the
 * access, links to the groups (undefined: keep the ones it has; none unless it's `groups`), and
 * what the rest see. Unknown groups, or groups with another access, are refused. Call it with the
 * project locked.
 */
async function accessChange(tx: Prisma.TransactionClient, projectId: string, input: { access?: Access; groups?: string[]; noAccess?: WithoutAccess }) {
  const access = input.access ?? (input.groups === undefined ? undefined : input.groups.length > 0 ? "groups" : "inherit");
  const noAccess = input.noAccess && toNoAccess(input.noAccess);
  if (access === undefined) {
    return noAccess && { access: undefined, groups: undefined, noAccess };
  }
  if (access !== "groups" && input.groups?.length) {
    throw new OperationError(400, "invalid_input", "Groups go with access “groups”");
  }
  // Content for reader groups is on Business, where plans are sold; taking it off them always works.
  if (access === "groups") {
    await requirePlan(projectId, "privatePortal");
  }
  return {
    access: toReadAccess(access),
    groups: access !== "groups" ? [] : input.groups === undefined ? undefined : await groupLinks(tx, projectId, input.groups),
    noAccess,
  };
}

/** "Who can read" for the API, from `levelSelect`: its access, its groups' keys, and what the rest see of it. */
const accessView = (level: Level & { noAccess: NoAccess }) => ({
  access: fromReadAccess(level.access),
  groups: claimsOf(level),
  noAccess: fromNoAccess(level.noAccess),
});

const collectionFields = {
  name: z.string().trim().min(1, "Name is required").max(60),
  description: z.string().trim().max(300),
  /** A Lucide icon by name (kebab-case, as on lucide.dev, e.g. `credit-card`), shown next to its name; null for none. See checkIcon. */
  icon: z
    .string()
    .trim()
    .transform((name) => name || null)
    .nullable(),
};

/**
 * Refuses an icon the installed Lucide doesn't have, unless it's the one the collection has
 * (`current`): one Lucide dropped since stays, so it doesn't block saving the collection's other fields.
 */
function checkIcon(icon: string | null | undefined, current: string | null = null) {
  if (icon && icon !== current && !lucideIcon(icon)) {
    throw new OperationError(400, "invalid_input", `No icon named “${icon}”`);
  }
}

const articleSelect = {
  id: true,
  slug: true,
  title: true,
  body: true,
  content: true,
  publishedAt: true,
  deletedAt: true,
  showUpdatedDate: true,
  listing: true,
  ...levelSelect,
  customSlug: true,
  description: true,
  keywords: true,
  noindex: true,
  order: true,
  createdAt: true,
  updatedAt: true,
  collection: { select: { slug: true, name: true } },
  changes: { select: { title: true, body: true, content: true, updatedAt: true, collection: { select: { slug: true, name: true } } } },
} as const;
type ArticleRow = Prisma.ArticleGetPayload<{ select: typeof articleSelect }>;

/** `team`: the caller is on the project's team, so it sees the article's unpublished changes. */
/** The project's portal address, for article links. */
const portalOf = async (projectId: string) => portalAddress(await projectSlug(projectId));

function articleView({ changes, ...article }: ArticleRow, portal: string, team: boolean) {
  return {
    slug: article.slug,
    title: article.title,
    status: article.publishedAt ? ("published" as const) : ("draft" as const),
    publishedAt: article.publishedAt?.toISOString() ?? null,
    showUpdatedDate: article.showUpdatedDate,
    listing: article.listing.toLowerCase() as Listing,
    /** Only in the list of deleted articles. */
    ...(article.deletedAt && { deletedAt: article.deletedAt.toISOString() }),
    collection: article.collection,
    /** Its place among the articles in its collection (or in none): readers list them by this, then by title. */
    order: article.order,
    body: article.body,
    content: displayDoc(article),
    url: `${portal}/docs/${article.slug}`,
    /**
     * Only for the team: who can read it (`access`, `groups`; changed at once, like the listing), its
     * settings (`customSlug`: the team set its slug; `description`, `keywords`, `noindex`), and a
     * published article's saved changes that readers don't see yet (null if there are none), until
     * articles.publishChanges or articles.discardChanges.
     */
    ...(team && {
      ...accessView(article),
      customSlug: article.customSlug,
      description: article.description,
      keywords: article.keywords,
      noindex: article.noindex,
      changes: changes && {
        title: changes.title,
        body: changes.body,
        content: displayDoc(changes),
        collection: changes.collection,
        savedAt: changes.updatedAt.toISOString(),
      },
    }),
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };
}

/** A live (not deleted) article. */
const findArticle = (projectId: string, slug: string) =>
  prisma.article.findFirst({ where: { projectId, slug, deletedAt: null }, select: articleSelect });

async function teamArticle(projectId: string, slug: string) {
  const article = await findArticle(projectId, slug);
  if (!article) {
    throw new OperationError(404, "not_found", `There's no article “${slug}”`);
  }
  return article;
}

/**
 * The id for a collection slug (null for none, undefined to leave it), only from this project.
 * Read with the project locked, so the collection can't be deleted before the article is saved.
 */
async function collectionId(tx: Prisma.TransactionClient, projectId: string, slug: string | null | undefined) {
  if (slug === undefined || slug === null) {
    return slug;
  }
  const collection = await tx.collection.findUnique({ where: { projectId_slug: { projectId, slug } }, select: { id: true } });
  if (!collection) {
    throw new OperationError(400, "invalid_input", `There's no collection “${slug}”`);
  }
  return collection.id;
}

/** Where an article moving into collection `collectionId` (null: none) goes: last. */
async function lastArticle(tx: Prisma.TransactionClient, projectId: string, collectionId: string | null) {
  const last = await tx.article.aggregate({ where: { projectId, collectionId, deletedAt: null }, _max: { order: true } });
  return (last._max.order ?? -1) + 1;
}

/** Numbers the rows 0, 1, … in the order of `ids`, in one statement. */
async function renumber(tx: Prisma.TransactionClient, table: "article" | "collection" | "docs_tab", ids: string[]) {
  await tx.$executeRaw`
    UPDATE ${Prisma.raw(`"${table}"`)} t SET "order" = n.place - 1
    FROM unnest(${ids}::text[]) WITH ORDINALITY AS n(id, place)
    WHERE t.id = n.id`;
}

/** `id` at `position` (0 first; past the end or undefined, last) among `siblings`, the others in their order. */
function placed(siblings: { id: string }[], id: string, position: number | undefined) {
  const ids = siblings.map((sibling) => sibling.id).filter((sibling) => sibling !== id);
  ids.splice(Math.min(position ?? ids.length, ids.length), 0, id);
  return ids;
}

/**
 * A slug from `text` for a tab, collection or article (`page`, when it has one) that no other tab,
 * collection or live article in the project has, so /docs/<slug> is one page: "getting-started",
 * then "getting-started-2", … Call it with the project locked (lockProject), so two saves can't pick
 * the same one, in the transaction that gives the page the slug. Deleted articles don't hold on to
 * their slugs (a restored one takes the next free one if its own is gone).
 *
 * Redirects (docs_redirect) follow: a slug only a redirect has is free, and taking it drops the
 * redirect; when `page` gets a new slug, its old one (`page.slug`, read under the lock) redirects
 * to it.
 */
export async function freeDocsSlug(
  tx: Prisma.TransactionClient,
  projectId: string,
  text: string,
  kind: "tab" | "collection" | "article",
  page?: { id: string; slug: string },
) {
  const base = titleSlug(text, kind);
  const taken = await docsSlugsTaken(tx, projectId, { startsWith: base }, page);
  const used = new Set([...(kind === "article" ? RESERVED_ARTICLE_SLUGS : []), ...taken.map((row) => row.slug)]);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return claimDocsSlug(tx, projectId, candidate, kind, page);
}

/**
 * "new", "insights", "tabs" and "collections" are the team's pages under /app/<project>/docs (a tab's
 * and a collection's are under the last two), and /docs/api is the API reference (Tuti's own on the
 * app's domain, and later each portal's from an OpenAPI file), so no article can have them.
 */
const RESERVED_ARTICLE_SLUGS = ["new", "insights", "api", "tabs", "collections"];

/** The tabs, collections and live articles in the project (but `page`) whose slug matches `slug`, with their names. */
async function docsSlugsTaken(tx: Prisma.TransactionClient, projectId: string, slug: Prisma.StringFilter | string, page?: { id: string }) {
  // Ids are unique across the three tables (cuids), so `page` needs no kind.
  const where = { projectId, slug, ...(page && { id: { not: page.id } }) };
  return [
    ...(await tx.docsTab.findMany({ where, select: { slug: true, name: true } })).map((tab) => ({ ...tab, kind: "the tab" })),
    ...(await tx.collection.findMany({ where, select: { slug: true, name: true } })).map((c) => ({ ...c, kind: "the collection" })),
    ...(await tx.article.findMany({ where: { ...where, deletedAt: null }, select: { slug: true, title: true } })).map((a) => ({
      slug: a.slug,
      name: a.title,
      kind: "the article",
    })),
  ];
}

/**
 * `slug`, as the team picked it for an article (`page`, when it has one): unlike freeDocsSlug, never
 * another one. Refused when it's reserved or a tab, collection or other live article has it. Like
 * freeDocsSlug, call it with the project locked; redirects follow the same way.
 */
async function customDocsSlug(tx: Prisma.TransactionClient, projectId: string, slug: string, page?: { id: string; slug: string }) {
  if (RESERVED_ARTICLE_SLUGS.includes(slug)) {
    throw new OperationError(400, "invalid_input", `“${slug}” is reserved; pick another`);
  }
  const [taken] = await docsSlugsTaken(tx, projectId, slug, page);
  if (taken) {
    throw new OperationError(409, "conflict", `That address is taken by ${taken.kind} “${taken.name}”`);
  }
  return claimDocsSlug(tx, projectId, slug, "article", page);
}

/** Gives a page `candidate` (free, under the lock): a redirect with it goes, and `page`'s old slug redirects to it. */
async function claimDocsSlug(
  tx: Prisma.TransactionClient,
  projectId: string,
  candidate: string,
  kind: "tab" | "collection" | "article",
  page?: { id: string; slug: string },
) {
  await tx.docsRedirect.deleteMany({ where: { projectId, slug: candidate } });
  if (page && page.slug !== candidate) {
    const to = {
      tabId: kind === "tab" ? page.id : null,
      collectionId: kind === "collection" ? page.id : null,
      articleId: kind === "article" ? page.id : null,
    };
    await tx.docsRedirect.upsert({
      where: { projectId_slug: { projectId, slug: page.slug } },
      create: { projectId, slug: page.slug, ...to },
      update: to,
    });
  }
  return candidate;
}

/** Embeds a published article's sections for search, in the background. Never fails the save: search still matches its words. */
async function indexArticle(articleId: string) {
  try {
    await enqueue("articleChanged", { articleId });
  } catch (error) {
    log.error("Embedding an article for search failed", { articleId, error });
  }
}

async function articleText(input: { body?: string; content?: unknown }, projectId: string) {
  const text = await readContent("article", input, { projectId, maxLength: MAX_ARTICLE_LENGTH });
  if (text.error !== undefined) {
    throw new OperationError(400, "invalid_content", text.error);
  }
  return text;
}

type ArticleText = Awaited<ReturnType<typeof articleText>>;

/** Who a save is by: the person, or the API key's creator. */
const authorOf = (actor: Actor) => (actor.kind === "user" ? actor.userId : actor.createdById);

/** Deleted articles after this can still be restored. */
export const restorableSince = () => new Date(Date.now() - DELETED_ARTICLE_DAYS * 24 * 60 * 60 * 1000);

const versionSelect = { title: true, body: true, content: true, collectionId: true } as const;
type Version = Prisma.ArticleRevisionGetPayload<{ select: typeof versionSelect }>;

/** The article's published (or draft) version, and the one last saved: its unpublished changes if it has some. */
async function versions(tx: Prisma.TransactionClient, articleId: string): Promise<{ live: Version; saved: Version }> {
  const { changes, ...live } = await tx.article.findUniqueOrThrow({
    where: { id: articleId },
    select: { ...versionSelect, changes: { select: versionSelect } },
  });
  return { live, saved: changes ?? live };
}

const newestFirst: Prisma.ArticleRevisionOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

/**
 * Records the article's version as last saved (its unpublished changes, if it has some) as a
 * revision, unless it's the same as the newest one (a save that changed nothing), and lets the
 * oldest go past ARTICLE_REVISIONS_KEPT. Call it in the transaction that saved the article, with
 * the project locked, so saves can't interleave.
 */
export async function recordRevision(tx: Prisma.TransactionClient, articleId: string, authorId: string | null) {
  const article = (await versions(tx, articleId)).saved;
  const newest = await tx.articleRevision.findFirst({ where: { articleId }, orderBy: newestFirst, select: versionSelect });
  if (newest && isDeepStrictEqual(article, newest)) {
    return;
  }
  // Timed here, after the lock, so revisions are in the order their saves were.
  await tx.articleRevision.create({
    data: { articleId, ...article, content: article.content ?? Prisma.DbNull, authorId, createdAt: new Date() },
  });
  const old = await tx.articleRevision.findMany({
    where: { articleId },
    orderBy: newestFirst,
    skip: ARTICLE_REVISIONS_KEPT,
    select: { id: true },
  });
  if (old.length > 0) {
    await tx.articleRevision.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
  }
}

/** A live (not deleted) article, read again under the project's lock: it may have been retitled, published or deleted since. */
async function lockedArticle(tx: Prisma.TransactionClient, article: { id: string; slug: string }) {
  const current = await tx.article.findFirst({
    where: { id: article.id, deletedAt: null },
    select: { slug: true, customSlug: true, title: true, publishedAt: true, collectionId: true },
  });
  if (!current) {
    throw new OperationError(404, "not_found", `There's no article “${article.slug}”`);
  }
  return current;
}

/**
 * Keeps changes to a published article as unpublished ones, on top of those saved before (the last
 * save wins), so readers keep the published version. Changes that bring it back to the published
 * version are none.
 */
async function keepChanges(tx: Prisma.TransactionClient, articleId: string, changes: Partial<Version>) {
  const { live, saved } = await versions(tx, articleId);
  const next = { ...saved, ...changes };
  const data = { ...next, content: next.content ?? Prisma.DbNull };
  await tx.articleChanges.upsert({ where: { articleId }, create: { articleId, ...data }, update: data });
  // Compared as stored (JSON keys in Postgres' order).
  const kept = await tx.articleChanges.findUniqueOrThrow({ where: { articleId }, select: versionSelect });
  if (isDeepStrictEqual(kept, live)) {
    await tx.articleChanges.delete({ where: { articleId } });
  }
}

/**
 * Makes an article's unpublished changes its text: live (`published`, the portal's "Updated" date
 * moves), or its draft's as it's unpublished or deleted, so nothing saved is lost or goes live.
 * Search sections follow once the caller enqueues the article (indexArticle).
 */
async function applyChanges(tx: Prisma.TransactionClient, articleId: string, published: boolean) {
  const changes = await tx.articleChanges.findUnique({ where: { articleId }, select: versionSelect });
  if (!changes) {
    return;
  }
  const article = await tx.article.findUniqueOrThrow({ where: { id: articleId }, select: { projectId: true, collectionId: true } });
  await tx.article.update({
    where: { id: articleId },
    data: {
      ...changes,
      content: changes.content ?? Prisma.DbNull,
      ...(published && { revisedAt: new Date() }),
      ...(changes.collectionId !== article.collectionId && { order: await lastArticle(tx, article.projectId, changes.collectionId) }),
    },
  });
  await tx.articleChanges.delete({ where: { articleId } });
}

/**
 * Saves changes to a live article and records them as a revision. Call it with the project locked
 * (lockProject). A draft's text changes at once, and its slug follows its title (unless the team set
 * it). A published one keeps its slug, and its title, text and collection wait as unpublished changes
 * (unless `publish`, which makes them live with any saved before); its listing, who can read it,
 * "Updated" setting and settings (a slug the team sets, `newSlug`; description, keywords, noindex) change at once.
 */
async function saveChanges(
  tx: Prisma.TransactionClient,
  projectId: string,
  article: { id: string; slug: string },
  authorId: string | null,
  changes: {
    title?: string;
    text?: ArticleText;
    collectionId?: string | null;
    showUpdatedDate?: boolean;
    listing?: ArticleListing;
    access?: Awaited<ReturnType<typeof accessChange>>;
    /** A slug the team sets; null: back to one from the title (only a draft's then changes). */
    newSlug?: string | null;
    description?: string;
    keywords?: string[];
    noindex?: boolean;
  },
  publish = false,
) {
  const current = await lockedArticle(tx, article);
  const { title, text, collectionId, showUpdatedDate, listing, access, newSlug, description, keywords, noindex } = changes;
  const version = {
    ...(title !== undefined && { title }),
    ...(text && { body: text.text, content: text.doc }),
    ...(collectionId !== undefined && { collectionId }),
  };
  const data: Prisma.ArticleUncheckedUpdateInput = {
    ...(showUpdatedDate !== undefined && { showUpdatedDate }),
    ...(listing !== undefined && { listing }),
    ...(access && { access: access.access, noAccess: access.noAccess, ...(access.groups && { groups: { deleteMany: {}, create: access.groups } }) }),
    ...(description !== undefined && { description }),
    ...(keywords !== undefined && { keywords }),
    ...(noindex !== undefined && { noindex }),
  };
  const page = { id: article.id, slug: current.slug };
  if (newSlug) {
    Object.assign(data, { customSlug: true, slug: await customDocsSlug(tx, projectId, newSlug, page) });
  } else if (newSlug === null) {
    data.customSlug = false;
  }
  if (current.publishedAt) {
    if (Object.keys(version).length > 0) {
      await keepChanges(tx, article.id, version);
    }
    if (publish) {
      await applyChanges(tx, article.id, true);
    }
  } else {
    const retitled = title !== undefined && title !== current.title;
    const moved = collectionId !== undefined && collectionId !== current.collectionId;
    // Its slug follows its title, unless the team set it (now, or before and not turned off).
    const followsTitle = newSlug === null ? current.customSlug || retitled : newSlug === undefined && !current.customSlug && retitled;
    Object.assign(
      data,
      version,
      followsTitle && { slug: await freeDocsSlug(tx, projectId, title ?? current.title, "article", page) },
      moved && { order: await lastArticle(tx, projectId, collectionId) },
    );
  }
  // Only when something on the article changes: its updatedAt is the sitemap's lastmod.
  if (Object.keys(data).length > 0) {
    await tx.article.update({ where: { id: article.id }, data });
  }
  if (text) {
    await attachMedia(tx, projectId, text.mediaIds);
  }
  await recordRevision(tx, article.id, authorId);
  return tx.article.findUniqueOrThrow({ where: { id: article.id }, select: articleSelect });
}

/** An article's revisions, newest (the current version) first. */
export function articleRevisions(articleId: string) {
  return prisma.articleRevision.findMany({
    where: { articleId },
    orderBy: newestFirst,
    select: {
      id: true,
      title: true,
      body: true,
      content: true,
      createdAt: true,
      collection: { select: { slug: true, name: true } },
      author: { select: { name: true } },
    },
  });
}

export const listArticles = defineOperation({
  name: "articles.list",
  summary:
    "List docs articles by title: published ones (listed everywhere; the team sees every listing), the team's drafts (latest edited first), or deleted ones the team can still restore (latest deleted first)",
  method: "GET",
  path: "/articles",
  scope: "read",
  access: "anyone",
  input: z.object({
    status: z.enum(["published", "draft", "deleted"]).default("published"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  example: { status: "published", limit: 20 },
  run: async ({ actor, projectId }, input) => {
    const team = await isTeam(actor, projectId);
    if (input.status !== "published" && !team) {
      throw new OperationError(403, "forbidden", `Only the project's team sees ${input.status === "draft" ? "drafts" : "deleted articles"}`);
    }
    const query: Record<typeof input.status, Pick<Prisma.ArticleFindManyArgs, "where" | "orderBy">> = {
      // Like the portal's lists, but the team sees unlisted, hidden and AI-only ones too.
      // Not the ones for readers the caller isn't (signed-in readers, some groups), by the article, its collections or its tab.
      published: {
        where: team ? { publishedAt: { not: null }, deletedAt: null } : { ...listedArticle, ...(await readableArticle(projectId, await actorReader(actor, projectId))) },
        orderBy: [{ title: "asc" }, { slug: "asc" }],
      },
      draft: { where: { publishedAt: null, deletedAt: null }, orderBy: [{ updatedAt: "desc" }, { slug: "asc" }] },
      deleted: { where: { deletedAt: { gte: restorableSince() } }, orderBy: [{ deletedAt: "desc" }, { slug: "asc" }] },
    };
    const articles = await prisma.article.findMany({
      where: { projectId, ...query[input.status].where },
      orderBy: query[input.status].orderBy,
      skip: input.cursor,
      take: input.limit + 1,
      select: articleSelect,
    });
    const portal = await portalOf(projectId);
    return {
      articles: articles.slice(0, input.limit).map((article) => articleView(article, portal, team)),
      nextCursor: articles.length > input.limit ? String(input.cursor + input.limit) : null,
    };
  },
});

export const getArticle = defineOperation({
  name: "articles.get",
  summary:
    "Get a docs article by its slug (drafts, hidden and AI-only articles only for the team). The team also gets its unpublished `changes`",
  method: "GET",
  path: "/articles/{slug}",
  scope: "read",
  access: "anyone",
  input: z.object({ slug }),
  run: async ({ actor, projectId }, input) => {
    const [article, team] = await Promise.all([findArticle(projectId, input.slug), isTeam(actor, projectId)]);
    // An article without a page (a draft, hidden or AI only) is as good as missing to everyone but the team.
    const served = article?.publishedAt && SERVED.includes(article.listing);
    // Nor one that isn't for them (see articles.list).
    const visible = async (id: string) =>
      (await prisma.article.count({ where: { id, ...(await readableArticle(projectId, await actorReader(actor, projectId))) } })) > 0;
    if (!article || (!team && (!served || !(await visible(article.id))))) {
      throw new OperationError(404, "not_found", `There's no article “${input.slug}”`);
    }
    return articleView(article, await portalOf(projectId), team);
  },
});

export const searchArticles = defineOperation({
  name: "articles.search",
  summary: "Search the published docs articles: best matches first, each with the passage that matched. Each word also matches the words it starts (\"sig\" finds \"signing\"), so it works as someone types",
  method: "GET",
  path: "/search/articles",
  scope: "read",
  access: "anyone",
  input: z.object({
    q: z.string().trim().min(1, "Type something to search for").max(200),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  }),
  example: { q: "invite my team", limit: 5 },
  run: async ({ actor, projectId }, input) => {
    const [results, portal] = await Promise.all([searchDocs(projectId, input.q, input.limit, await actorReader(actor, projectId)), portalOf(projectId)]);
    return { results: results.map((result) => ({ ...result, url: `${portal}/docs/${result.slug}` })) };
  },
});

export const createArticle = defineOperation({
  name: "articles.create",
  summary:
    "Write a docs article (a draft until it's published); its slug comes from the title, unless you set one (`slug`: lowercase letters, digits and hyphens; refused if it's taken, never changed). `access` says who can read it once it's published, on top of its collection and tab (`inherit`, the default; `signed_in`; or `groups`, with `groups`), and `noAccess` what people it isn't for see of it (`inherit`, the default: as its collection; `lock`: its title with a lock, never its text; or `hide`). `description`, `keywords` and `noindex` as in articles.update",
  method: "POST",
  path: "/articles",
  scope: "write",
  access: "team",
  input: z.object({
    ...articleFields,
    ...accessFields,
    /** The end of its URL (/docs/<slug>) instead of one from the title: lowercase letters, digits and hyphens. */
    slug: customSlug.optional(),
  }),
  example: { title: "Getting started", body: "Create a board, then share your portal.", collection: "basics" },
  run: async ({ actor, projectId }, input) => {
    // Before anything is written: a lookup failing after would fail a request that did its work.
    const portal = await portalOf(projectId);
    const text = await articleText(input, projectId);
    const article = await saving(() =>
      prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const collection = await collectionId(tx, projectId, input.collection);
        const access = await accessChange(tx, projectId, input);
        const created = await tx.article.create({
          data: {
            projectId,
            ...(input.slug
              ? { slug: await customDocsSlug(tx, projectId, input.slug), customSlug: true }
              : { slug: await freeDocsSlug(tx, projectId, input.title, "article") }),
            title: input.title,
            body: text.text,
            content: text.doc,
            collectionId: collection ?? null,
            order: await lastArticle(tx, projectId, collection ?? null),
            showUpdatedDate: input.showUpdatedDate,
            listing: input.listing && toListing(input.listing),
            ...(access && { access: access.access, noAccess: access.noAccess, groups: { create: access.groups ?? [] } }),
            description: input.description,
            keywords: input.keywords,
            noindex: input.noindex,
            createdById: authorOf(actor),
          },
          select: articleSelect,
        });
        await attachMedia(tx, projectId, text.mediaIds);
        await recordRevision(tx, created.id, authorOf(actor));
        return created;
      }),
    );
    return articleView(article, portal, true);
  },
});

export const updateArticle = defineOperation({
  name: "articles.update",
  summary:
    "Change a docs article: its title, text, collection or `listing` (everywhere, unlisted, hidden or ai_only) (a draft's slug follows its title; a published one keeps it). Each change is kept as a version (see articles.revisions). On a published article, changes to the title, text and collection are kept as unpublished `changes` (readers see the published version until articles.publishChanges); with `publish: true` they go live at once, with any changes saved before. The listing, who can read it and what the rest see (`access`, `groups` and `noAccess`, as in articles.create), showUpdatedDate and its settings change at once: `newSlug` sets the end of its URL (as `slug` in articles.create; on a published one too, and the old address redirects), null goes back to one from the title (a draft's follows it again; a published one keeps the one it has); `description` (the meta description; empty: from the text), `keywords` (searched like the text) and `noindex` (block search indexing)",
  method: "PATCH",
  path: "/articles/{slug}",
  scope: "write",
  access: "team",
  input: z.object({
    slug,
    ...articleFields,
    ...accessFields,
    title: articleFields.title.optional(),
    /** A new slug, set by you (see articles.create's `slug`); null: back to one from the title. */
    newSlug: customSlug.nullable().optional(),
    /** On a published article: make the changes live at once instead of keeping them unpublished. Ignored on a draft. */
    publish: z.boolean().optional(),
    /** Only if the article's newest version (its id from articles.revisions) is still this one: someone may have saved it since. Otherwise it's a 409. */
    revision: z.string().min(1).optional(),
  }),
  example: { body: "Owners and admins invite from the Team page.", publish: true },
  run: async ({ actor, projectId }, input) => {
    // Looked up before writing, like articles.create.
    const portal = await portalOf(projectId);
    const article = await teamArticle(projectId, input.slug);
    const text = input.body !== undefined || input.content !== undefined ? await articleText(input, projectId) : undefined;
    const updated = await saving(() =>
      prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        if (input.revision !== undefined) {
          const newest = await tx.articleRevision.findFirst({ where: { articleId: article.id }, orderBy: newestFirst, select: { id: true } });
          if (newest?.id !== input.revision) {
            throw new OperationError(409, "changed", "The article was saved again since. Reload it to see the changes.");
          }
        }
        const collection = await collectionId(tx, projectId, input.collection);
        return saveChanges(
          tx,
          projectId,
          article,
          authorOf(actor),
          {
            title: input.title,
            text,
            collectionId: collection,
            showUpdatedDate: input.showUpdatedDate,
            listing: input.listing && toListing(input.listing),
            access: await accessChange(tx, projectId, input),
            newSlug: input.newSlug,
            description: input.description,
            keywords: input.keywords,
            noindex: input.noindex,
          },
          input.publish,
        );
      }),
    );
    // Keywords are embedded with the text (the job skips an article whose embedded text is the same).
    if (updated.publishedAt && (input.publish || input.keywords !== undefined)) {
      await indexArticle(updated.id);
    }
    return articleView(updated, portal, true);
  },
});

export const listRevisions = defineOperation({
  name: "articles.revisions",
  summary: `A docs article's saved versions, newest (the current one) first, with who saved each and its text (the latest ${ARTICLE_REVISIONS_KEPT} are kept)`,
  method: "GET",
  path: "/articles/{slug}/revisions",
  scope: "read",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    const revisions = await articleRevisions(article.id);
    return {
      revisions: revisions.map((revision, index) => ({
        id: revision.id,
        title: revision.title,
        body: revision.body,
        collection: revision.collection,
        author: revision.author,
        createdAt: revision.createdAt.toISOString(),
        current: index === 0,
      })),
    };
  },
});

export const restoreArticle = defineOperation({
  name: "articles.restore",
  summary: `Restore a docs article. With \`revision\` (from articles.revisions), that version becomes the current one, saved as a new version (on a published article, as unpublished \`changes\`, like any save). Without it, the article most recently deleted with this slug (in the last ${DELETED_ARTICLE_DAYS} days) comes back as a draft, under the same slug unless a tab, a collection or another article has taken it (then the next free one)`,
  method: "POST",
  path: "/articles/{slug}/restore",
  scope: "write",
  access: "team",
  input: z.object({ slug, revision: z.string().trim().min(1).max(100).optional() }),
  run: async ({ actor, projectId }, input) => {
    // Looked up before writing, like articles.create.
    const portal = await portalOf(projectId);
    const restorable = { projectId, slug: input.slug, OR: [{ deletedAt: null }, { deletedAt: { gte: restorableSince() } }] };
    let article: { id: string; slug: string; deletedAt: Date | null } | null;
    let version: (Prisma.ArticleRevisionGetPayload<{ select: typeof versionSelect }> & { text: ArticleText }) | undefined;
    if (input.revision !== undefined) {
      const revision = await prisma.articleRevision.findFirst({
        where: { id: input.revision, article: restorable },
        select: { ...versionSelect, article: { select: { id: true, slug: true, deletedAt: true } } },
      });
      if (!revision) {
        throw new OperationError(404, "not_found", `“${input.slug}” has no version “${input.revision}”`);
      }
      article = revision.article;
      // Checked like any save: it must still fit the article profile, and its images must still be there.
      version = { ...revision, text: await articleText({ content: revision.content ?? undefined, body: revision.body }, projectId) };
    } else {
      if (await findArticle(projectId, input.slug)) {
        throw new OperationError(400, "invalid_input", `“${input.slug}” isn't deleted; say which \`revision\` to restore`);
      }
      article = await prisma.article.findFirst({
        where: { ...restorable, deletedAt: { not: null } },
        orderBy: { deletedAt: "desc" },
        select: { id: true, slug: true, deletedAt: true },
      });
      if (!article) {
        throw new OperationError(404, "not_found", `There's no deleted article “${input.slug}”`);
      }
    }
    const { id, deletedAt } = article;

    const restored = await saving(() =>
      prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        // Read again under the lock: a restore at the same time may have brought it back already.
        const deleted = deletedAt && (await tx.article.findFirst({ where: { id, deletedAt: { not: null } }, select: { slug: true } }));
        if (deleted) {
          // Back as a draft (deleting unpublished it), under its slug unless a tab, a collection or another article has it now.
          await tx.article.update({
            where: { id },
            data: { deletedAt: null, slug: await freeDocsSlug(tx, projectId, deleted.slug, "article", { id, slug: deleted.slug }) },
          });
        }
        return saveChanges(
          tx,
          projectId,
          article,
          authorOf(actor),
          version ? { title: version.title, text: version.text, collectionId: version.collectionId } : {},
        );
      }),
    );
    return articleView(restored, portal, true);
  },
});

export const publishArticle = defineOperation({
  name: "articles.publish",
  summary: "Publish a docs article on the portal",
  method: "POST",
  path: "/articles/{slug}/publish",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    // Looked up before writing, like articles.create.
    const portal = await portalOf(projectId);
    const article = await teamArticle(projectId, input.slug);
    // Only the first publish sets the date. Locked, so a draft's slug can't change as it's published.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await tx.article.updateMany({ where: { id: article.id, publishedAt: null, deletedAt: null }, data: { publishedAt: new Date() } });
    });
    await indexArticle(article.id);
    return articleView(await teamArticle(projectId, input.slug), portal, true);
  },
});

const changesInput = z.object({
  slug,
  /**
   * Only if the changes are still the ones saved then (their `changes.savedAt`), e.g. the ones the
   * team reviewed: someone may have saved more since. Otherwise it's a 409.
   */
  savedAt: z.iso.datetime().optional(),
});

/** Checks `savedAt` against the article's changes. Call it with the project locked, so no save slips in after it. */
async function checkSavedAt(tx: Prisma.TransactionClient, articleId: string, savedAt: string | undefined) {
  if (savedAt === undefined) {
    return;
  }
  const changes = await tx.articleChanges.findUnique({ where: { articleId }, select: { updatedAt: true } });
  if (changes && changes.updatedAt.getTime() !== new Date(savedAt).getTime()) {
    throw new OperationError(409, "changed", "The changes were saved again since. Reload the page to review them.");
  }
}

export const publishChanges = defineOperation({
  name: "articles.publishChanges",
  summary:
    "Publish a docs article's unpublished `changes` (see articles.update): readers, search and AI answers get them. Without changes it does nothing",
  method: "POST",
  path: "/articles/{slug}/publish-changes",
  scope: "write",
  access: "team",
  input: changesInput,
  run: async ({ actor, projectId }, input) => {
    // Looked up before writing, like articles.create.
    const portal = await portalOf(projectId);
    const article = await teamArticle(projectId, input.slug);
    // One transaction, locked like a save: the changes saved last are the ones that go live.
    const published = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await lockedArticle(tx, article);
      await checkSavedAt(tx, article.id, input.savedAt);
      await applyChanges(tx, article.id, true);
      await recordRevision(tx, article.id, authorOf(actor));
      return tx.article.findUniqueOrThrow({ where: { id: article.id }, select: articleSelect });
    });
    if (published.publishedAt) {
      await indexArticle(article.id);
    }
    return articleView(published, portal, true);
  },
});

export const discardChanges = defineOperation({
  name: "articles.discardChanges",
  summary:
    "Drop a docs article's unpublished `changes`: it's back to the published version (saved as a new version, so the changes stay in articles.revisions). Without changes it does nothing",
  method: "POST",
  path: "/articles/{slug}/discard-changes",
  scope: "write",
  access: "team",
  input: changesInput,
  run: async ({ actor, projectId }, input) => {
    // Looked up before writing, like articles.create.
    const portal = await portalOf(projectId);
    const article = await teamArticle(projectId, input.slug);
    const discarded = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await lockedArticle(tx, article);
      await checkSavedAt(tx, article.id, input.savedAt);
      await tx.articleChanges.deleteMany({ where: { articleId: article.id } });
      await recordRevision(tx, article.id, authorOf(actor));
      return tx.article.findUniqueOrThrow({ where: { id: article.id }, select: articleSelect });
    });
    return articleView(discarded, portal, true);
  },
});

export const unpublishArticle = defineOperation({
  name: "articles.unpublish",
  summary: "Take a docs article off the portal (back to a draft, with its unpublished changes as the draft's text)",
  method: "POST",
  path: "/articles/{slug}/unpublish",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    // Looked up before writing, like articles.create.
    const portal = await portalOf(projectId);
    const article = await teamArticle(projectId, input.slug);
    // Its chunks go with it, so search and AI answers stop using it at once. Its unpublished
    // changes become the draft's text (it's what was saved last; nothing of it goes live).
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await lockedArticle(tx, article);
      await applyChanges(tx, article.id, false);
      await tx.article.update({ where: { id: article.id }, data: { publishedAt: null } });
      await tx.articleChunk.deleteMany({ where: { articleId: article.id } });
    });
    return articleView(await teamArticle(projectId, input.slug), portal, true);
  },
});

export const deleteArticle = defineOperation({
  name: "articles.delete",
  summary: `Delete a docs article; the team can restore it (with articles.restore) for ${DELETED_ARTICLE_DAYS} days`,
  method: "DELETE",
  path: "/articles/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    // Unpublished as it's deleted (a deleted article is never published), so it leaves the portal and search at once.
    // Like unpublishing, its unpublished changes become its text: restored, it's the draft as last saved.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await lockedArticle(tx, article);
      await applyChanges(tx, article.id, false);
      await tx.article.updateMany({ where: { id: article.id, deletedAt: null }, data: { deletedAt: new Date(), publishedAt: null } });
      await tx.articleChunk.deleteMany({ where: { articleId: article.id } });
    });
    return { deleted: input.slug };
  },
});


const position = z.number().int().min(0).max(10_000);

export const reorderArticle = defineOperation({
  name: "articles.reorder",
  summary:
    "Move a docs article within its collection, or into another (`collection`, null for none), at `position` (0 first; left out, last); the others keep their order around it. Readers list articles in this order. A move to another collection goes live at once, on a published article too (its unpublished changes move with it), and is kept as a version",
  method: "POST",
  path: "/articles/{slug}/reorder",
  scope: "write",
  access: "team",
  input: z.object({ slug, collection: slug.nullable().optional(), position: position.optional() }),
  example: { collection: "basics", position: 0 },
  run: async ({ actor, projectId }, input) => {
    // Looked up before writing, like articles.create.
    const portal = await portalOf(projectId);
    const article = await teamArticle(projectId, input.slug);
    // One transaction under the project's lock: moves at the same time renumber one after the other, never over each other.
    const moved = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const current = await lockedArticle(tx, article);
      const target = input.collection === undefined ? current.collectionId : ((await collectionId(tx, projectId, input.collection)) ?? null);
      if (target !== current.collectionId) {
        await tx.article.update({ where: { id: article.id }, data: { collectionId: target } });
        // Publishing the changes later mustn't move it back.
        if ((await tx.articleChanges.count({ where: { articleId: article.id } })) > 0) {
          await keepChanges(tx, article.id, { collectionId: target });
        }
        await recordRevision(tx, article.id, authorOf(actor));
      }
      const siblings = await tx.article.findMany({
        where: { projectId, collectionId: target, deletedAt: null },
        orderBy: [{ order: "asc" }, { title: "asc" }],
        select: { id: true },
      });
      await renumber(tx, "article", placed(siblings, article.id, input.position));
      return tx.article.findUniqueOrThrow({ where: { id: article.id }, select: articleSelect });
    });
    return articleView(moved, portal, true);
  },
});

const collectionSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  order: true,
  parentId: true,
  parent: { select: { slug: true } },
  tab: { select: { slug: true } },
  ...levelSelect,
  icon: true,
  _count: { select: { articles: { where: { deletedAt: null } } } },
} as const;
type CollectionRow = Prisma.CollectionGetPayload<{ select: typeof collectionSelect }>;
/** Collection `row` for the API; `tree` is every collection in its project (for its tab, its top-level one's). */
const collectionView = (row: CollectionRow, tree: CollectionRow[]) => ({
  slug: row.slug,
  name: row.name,
  description: row.description,
  /** Its Lucide icon's name, or null for none. */
  icon: row.icon,
  /**
   * Who can read it (`access`), and with `groups` the reader groups (keys); on top of its tab and the
   * collections it's in, which can only narrow it.
   */
  ...accessView(row),
  /** The collection it's in (its slug), or null at the top level. */
  parent: row.parent?.slug ?? null,
  /** The tab it's in (a collection in another is in its top-level one's), or null if the docs have no tabs. */
  tab: ancestry(tree, row.id).at(-1)?.tab?.slug ?? null,
  order: row.order,
  articles: row._count.articles,
});

/** Collection `id` for the API. */
async function collectionIn(tx: Prisma.TransactionClient, projectId: string, id: string) {
  const tree = await tx.collection.findMany({ where: { projectId }, select: collectionSelect });
  return collectionView(tree.find((c) => c.id === id)!, tree);
}

const siblingOrder: Prisma.CollectionOrderByWithRelationInput[] = [{ order: "asc" }, { name: "asc" }];
const tabOrder: Prisma.DocsTabOrderByWithRelationInput[] = [{ order: "asc" }, { name: "asc" }];

/** Collection `slug`, read under the project's lock (it may have been renamed or deleted since the caller looked). */
async function lockedCollection(tx: Prisma.TransactionClient, projectId: string, slug: string) {
  const collection = await tx.collection.findUnique({
    where: { projectId_slug: { projectId, slug } },
    select: { id: true, name: true, icon: true, parentId: true, tabId: true },
  });
  if (!collection) {
    throw new OperationError(404, "not_found", `There's no collection “${slug}”`);
  }
  return collection;
}

/** The project's collections, for parentFor and the way up to a top-level one. Read them with the project locked. */
const treeOf = (tx: Prisma.TransactionClient, projectId: string) =>
  tx.collection.findMany({ where: { projectId }, select: { id: true, slug: true, parentId: true, tabId: true } });

/**
 * The id of collection `slug` (null: the top level) for `collection` (undefined: a new one) to go
 * in, from `tree` (treeOf): not the collection itself or one inside it (no loops), and the
 * collection, with the ones in it, no more than MAX_COLLECTION_DEPTH levels deep there.
 */
function parentFor(tree: Awaited<ReturnType<typeof treeOf>>, collection: { id: string } | undefined, slug: string | null) {
  if (slug === null) {
    return null;
  }
  const parent = tree.find((c) => c.slug === slug);
  if (!parent) {
    throw new OperationError(400, "invalid_input", `There's no collection “${slug}”`);
  }
  const up = ancestry(tree, parent.id);
  if (collection && up.some((c) => c.id === collection.id)) {
    throw new OperationError(400, "invalid_input", "A collection can't go inside itself or one inside it");
  }
  if (up.length + (collection ? height(tree, collection.id) : 1) > MAX_COLLECTION_DEPTH) {
    throw new OperationError(400, "invalid_input", `Collections go ${MAX_COLLECTION_DEPTH} levels deep at most`);
  }
  return parent.id;
}

/** Links to the project's groups with these keys, for a tab, collection or article; one that isn't there is refused. Call it with the project locked. */
async function groupLinks(tx: Prisma.TransactionClient, projectId: string, keys: string[]) {
  const groups = await tx.readerGroup.findMany({ where: { projectId, key: { in: keys } }, select: { id: true, key: true } });
  const missing = keys.find((key) => !groups.some((group) => group.key === key));
  if (missing !== undefined) {
    throw new OperationError(400, "invalid_input", `There's no group “${missing}”: add it in Settings → Groups first`);
  }
  return groups.map((group) => ({ groupId: group.id }));
}

/** The collections in `parentId`, or at the top level (`parentId` null) in tab `tabId`. */
const siblingsWhere = (projectId: string, parentId: string | null, tabId: string | null): Prisma.CollectionWhereInput =>
  parentId === null ? { projectId, parentId, tabId } : { projectId, parentId };

/**
 * Puts collection `id` in `parentId` (or at the top level of tab `tabId`, when `parentId`
 * is null) at `position` among the collections there (see `placed`). Call it with the project locked.
 */
async function placeCollection(
  tx: Prisma.TransactionClient,
  projectId: string,
  id: string,
  { parentId, tabId }: { parentId: string | null; tabId: string | null },
  at?: number,
) {
  const place = { parentId, tabId: parentId === null ? tabId : null };
  await tx.collection.update({ where: { id }, data: place });
  const siblings = await tx.collection.findMany({ where: siblingsWhere(projectId, place.parentId, place.tabId), orderBy: siblingOrder, select: { id: true } });
  await renumber(tx, "collection", placed(siblings, id, at));
}

/** The project's tabs in order. Read with the project locked when the answer decides where something goes. */
const tabsOf = (tx: Prisma.TransactionClient, projectId: string) =>
  tx.docsTab.findMany({ where: { projectId }, orderBy: tabOrder, select: { id: true, slug: true, name: true } });

/**
 * The tab a collection at the top level goes in: tab `slug` if one is named (only at the
 * top level: one inside another is in its parent's), else `fallback`, else the first one (null when
 * the docs have none). Call it with the project locked.
 */
export async function tabFor(
  tx: Prisma.TransactionClient,
  projectId: string,
  { slug, parentId, fallback }: { slug: string | undefined; parentId: string | null; fallback?: string | null },
) {
  if (parentId !== null) {
    if (slug !== undefined) {
      throw new OperationError(400, "invalid_input", "A collection inside another is in that one's tab, so it can't have its own");
    }
    return null;
  }
  const tabs = await tabsOf(tx, projectId);
  if (slug !== undefined) {
    const tab = tabs.find((s) => s.slug === slug);
    if (!tab) {
      throw new OperationError(400, "invalid_input", `There's no tab “${slug}”`);
    }
    return tab.id;
  }
  return tabs.find((s) => s.id === fallback)?.id ?? tabs[0]?.id ?? null;
}

/**
 * Where collection `collection` goes for `parent` (null: the top level; undefined: where it is) and
 * `tab`: at the top level, the named tab, else the one it's in (or its top-level one's, coming
 * out of it). Call it with the project locked.
 */
async function placeFor(
  tx: Prisma.TransactionClient,
  projectId: string,
  collection: Awaited<ReturnType<typeof lockedCollection>>,
  input: { parent?: string | null; tab?: string },
) {
  const tree = await treeOf(tx, projectId);
  const parentId = input.parent === undefined ? collection.parentId : parentFor(tree, collection, input.parent);
  const fallback = ancestry(tree, collection.id).at(-1)?.tabId ?? null;
  return { parentId, tabId: await tabFor(tx, projectId, { slug: input.tab, parentId, fallback }) };
}

export const listCollections = defineOperation({
  name: "collections.list",
  summary:
    "List the docs' collections in order (by tab, each top-level one, then the ones in it), with the collection each is in (`parent`), its tab, its icon and how many articles each has",
  method: "GET",
  path: "/collections",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => {
    const collections = await prisma.collection.findMany({ where: { projectId }, orderBy: readingOrder, select: collectionSelect });
    return { collections: inTreeOrder(collections).map((c) => collectionView(c, collections)) };
  },
});

export const createCollection = defineOperation({
  name: "collections.create",
  summary:
    "Add a docs collection, at the top level (in `tab`; left out, the first one, if the docs have tabs) or in another collection (`parent`; 5 levels deep at most), after the others there; its slug comes from the name. `access` says who can read it and what's in it, on top of its tab and the collections it's in (`inherit`, the default; `signed_in`; or `groups`, readers in one of `groups`, keys of the project's reader groups (see groups.list), besides the team; `groups` alone, as before, means `groups`); `icon` names a Lucide icon (lucide.dev) shown next to its name. `noAccess` says what people it isn't for see of it and what's in it (`inherit`, the default; `lock`: its name with a lock, nothing in it; or `hide`)",
  method: "POST",
  path: "/collections",
  scope: "write",
  access: "team",
  input: z.object({
    ...collectionFields,
    ...accessFields,
    description: collectionFields.description.default(""),
    icon: collectionFields.icon.default(null),
    parent: slug.nullable().optional(),
    tab: slug.optional(),
  }),
  example: { name: "Getting started", description: "The basics, in five minutes.", icon: "rocket" },
  run: async ({ projectId }, input) =>
    prisma.$transaction(async (tx) => {
      checkIcon(input.icon);
      await lockProject(tx, projectId);
      const parentId = parentFor(await treeOf(tx, projectId), undefined, input.parent ?? null);
      const tabId = await tabFor(tx, projectId, { slug: input.tab, parentId });
      const last = await tx.collection.aggregate({ where: siblingsWhere(projectId, parentId, tabId), _max: { order: true } });
      const access = await accessChange(tx, projectId, input);
      const { id } = await tx.collection.create({
        data: {
          projectId,
          parentId,
          tabId,
          slug: await freeDocsSlug(tx, projectId, input.name, "collection"),
          name: input.name,
          description: input.description,
          ...(access && { access: access.access, noAccess: access.noAccess, groups: { create: access.groups ?? [] } }),
          icon: input.icon,
          order: (last._max.order ?? -1) + 1,
        },
        select: { id: true },
      });
      return collectionIn(tx, projectId, id);
    }),
});

export const updateCollection = defineOperation({
  name: "collections.update",
  summary:
    "Rename a docs collection (its slug follows the name), change its description, move it into another collection (`parent`, null for the top level; it goes last there), to another tab (`tab`, at the top level), set who can read it (`access` and `groups`, as in collections.create; `groups` alone, as before: some make it `groups`, none `inherit`), its `icon` (a Lucide icon's name; null removes it) what people it isn't for see (`noAccess`, as in collections.create), or set its `order` among its siblings. To move it to a place, see collections.reorder",
  method: "PATCH",
  path: "/collections/{slug}",
  scope: "write",
  access: "team",
  input: z.object({
    slug,
    name: collectionFields.name.optional(),
    description: collectionFields.description.optional(),
    ...accessFields,
    icon: collectionFields.icon.optional(),
    parent: slug.nullable().optional(),
    tab: slug.optional(),
    order: position.optional(),
  }),
  example: { name: "Basics", parent: null },
  run: async ({ projectId }, input) =>
    prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const collection = await lockedCollection(tx, projectId, input.slug);
      const { id } = collection;
      checkIcon(input.icon, collection.icon);
      if (input.parent !== undefined || input.tab !== undefined) {
        const place = await placeFor(tx, projectId, collection, input);
        if (place.parentId !== collection.parentId || place.tabId !== collection.tabId) {
          await placeCollection(tx, projectId, id, place);
        }
      }
      const access = await accessChange(tx, projectId, input);
      await tx.collection.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name, slug: await freeDocsSlug(tx, projectId, input.name, "collection", { id, slug: input.slug }) }),
          ...(input.description !== undefined && { description: input.description }),
          ...(access && { access: access.access, noAccess: access.noAccess, ...(access.groups && { groups: { deleteMany: {}, create: access.groups } }) }),
          ...(input.icon !== undefined && { icon: input.icon }),
          ...(input.order !== undefined && { order: input.order }),
        },
      });
      return collectionIn(tx, projectId, id);
    }),
});

export const reorderCollection = defineOperation({
  name: "collections.reorder",
  summary:
    "Move a docs collection among its siblings, into another collection (`parent`, null for the top level; 5 levels deep at most, and not one inside it) or to another tab (`tab`, at the top level; left out, the one it's in, or was in through its parent), at `position` (0 first; left out, last); the others keep their order around it. Readers list collections in this order",
  method: "POST",
  path: "/collections/{slug}/reorder",
  scope: "write",
  access: "team",
  input: z.object({ slug, parent: slug.nullable().optional(), tab: slug.optional(), position: position.optional() }),
  example: { parent: null, position: 0 },
  run: async ({ projectId }, input) =>
    prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const collection = await lockedCollection(tx, projectId, input.slug);
      await placeCollection(tx, projectId, collection.id, await placeFor(tx, projectId, collection, input), input.position);
      return collectionIn(tx, projectId, collection.id);
    }),
});

export const deleteCollection = defineOperation({
  name: "collections.delete",
  summary: "Delete a docs collection; the collections in it move up a level, in its place, and its articles stay, without a collection",
  method: "DELETE",
  path: "/collections/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    // Locked, so an article or collection being saved into it lands first (and is let go) or finds it gone.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const collection = await lockedCollection(tx, projectId, input.slug);
      const children = await tx.collection.findMany({ where: { parentId: collection.id }, orderBy: siblingOrder, select: { id: true } });
      if (children.length > 0) {
        const siblings = await tx.collection.findMany({
          where: siblingsWhere(projectId, collection.parentId, collection.tabId),
          orderBy: siblingOrder,
          select: { id: true },
        });
        // Up a level: into the one it was in, or at the top level in its tab.
        await tx.collection.updateMany({ where: { parentId: collection.id }, data: { parentId: collection.parentId, tabId: collection.tabId } });
        await renumber(
          tx,
          "collection",
          siblings.flatMap((sibling) => (sibling.id === collection.id ? children : [sibling])).map((sibling) => sibling.id),
        );
      }
      // Its articles go last among those in no collection, in their order (the delete then lets them go).
      const articlesIn = (collectionId: string | null) =>
        tx.article.findMany({ where: { projectId, collectionId, deletedAt: null }, orderBy: [{ order: "asc" }, { title: "asc" }], select: { id: true } });
      const inIt = await articlesIn(collection.id);
      if (inIt.length > 0) {
        await renumber(tx, "article", [...(await articlesIn(null)), ...inIt].map((article) => article.id));
      }
      await tx.collection.delete({ where: { id: collection.id } });
    });
    return { deleted: input.slug };
  },
});

export const tabSelect = {
  id: true,
  slug: true,
  name: true,
  order: true,
  ...levelSelect,
  landing: true,
  landingArticle: { select: { slug: true, deletedAt: true } },
  landingCollection: { select: { slug: true } },
  _count: { select: { collections: true } },
} as const;
type TabRow = Prisma.DocsTabGetPayload<{ select: typeof tabSelect }>;
export const tabView = ({ slug, name, order, landing, landingArticle, landingCollection, _count, ...level }: TabRow) => ({
  slug,
  name,
  order,
  /** Who can read it (`access`), and with `groups` the reader groups (keys): its collections and, on the first, the articles in none. */
  ...accessView(level),
  /** Its top-level collections (each with the ones in it). */
  collections: _count.collections,
  /** What its path shows: an `overview`, its `first` article, or a `page` the team picked (landingPage). */
  landing: landing.toLowerCase() as DocsLanding,
  /** With `page`: the article's or collection's slug (null once it's deleted). */
  landingPage: (landingArticle && !landingArticle.deletedAt ? landingArticle.slug : null) ?? landingCollection?.slug ?? null,
});
const tabName = z.string().trim().min(1, "Name is required").max(40);

export const LANDINGS = ["overview", "first", "page"] as const;
export type DocsLanding = (typeof LANDINGS)[number];

/**
 * The landing page `slug` may be for `tab` (`first`: the docs' first tab, which has the articles in
 * no collection): a (live) article or a collection in it. Read under the project's lock.
 */
async function landingPageIn(tx: Prisma.TransactionClient, projectId: string, tab: { id: string; first: boolean }, slug: string) {
  const tree = await treeOf(tx, projectId);
  const inTab = (collectionId: string | null) => (collectionId === null ? tab.first : ancestry(tree, collectionId).at(-1)?.tabId === tab.id);
  const article = await tx.article.findFirst({ where: { projectId, slug, deletedAt: null }, select: { id: true, collectionId: true } });
  if (article && inTab(article.collectionId)) {
    return { landingArticleId: article.id, landingCollectionId: null };
  }
  const collection = tree.find((c) => c.slug === slug);
  if (collection && inTab(collection.id)) {
    return { landingArticleId: null, landingCollectionId: collection.id };
  }
  throw new OperationError(400, "invalid_input", `There's no article or collection “${slug}” in this tab`);
}

/** Tab `slug`, read under the project's lock. */
async function lockedTab(tx: Prisma.TransactionClient, projectId: string, slug: string) {
  const tab = await tx.docsTab.findUnique({ where: { projectId_slug: { projectId, slug } }, select: { id: true, name: true } });
  if (!tab) {
    throw new OperationError(404, "not_found", `There's no tab “${slug}”`);
  }
  return tab;
}

export const listTabs = defineOperation({
  name: "tabs.list",
  summary:
    "List the docs' tabs in order, each with its collections and what its path shows (`landing`, `landingPage`; see tabs.update). Without tabs, the docs are one page",
  method: "GET",
  path: "/tabs",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({
    tabs: (await prisma.docsTab.findMany({ where: { projectId }, orderBy: tabOrder, select: tabSelect })).map(tabView),
  }),
});

export const createTab = defineOperation({
  name: "tabs.create",
  summary:
    "Add a docs tab, after the others; its slug comes from the name. The first one takes every top-level collection: once there are tabs, each top-level collection is in one. `access` says who can read it (`inherit`, the default: everyone who may read the portal; `signed_in`; or `groups`, with `groups`), and so what's in it; the first tab's is also the articles' in no collection. `noAccess` says what people it isn't for see of it (`inherit`, the default: hidden; `lock`: its name with a lock, nothing in it; or `hide`)",
  method: "POST",
  path: "/tabs",
  scope: "write",
  access: "team",
  input: z.object({ name: tabName, ...accessFields }),
  example: { name: "Guides" },
  run: async ({ projectId }, input) =>
    tabView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const last = await tx.docsTab.aggregate({ where: { projectId }, _max: { order: true } });
        const access = await accessChange(tx, projectId, input);
        const tab = await tx.docsTab.create({
          data: {
            projectId,
            slug: await freeDocsSlug(tx, projectId, input.name, "tab"),
            name: input.name,
            order: (last._max.order ?? -1) + 1,
            ...(access && { access: access.access, noAccess: access.noAccess, groups: { create: access.groups ?? [] } }),
          },
          select: { id: true },
        });
        // The first tab: the collections there are go in it, in their order.
        if (last._max.order === null) {
          await tx.collection.updateMany({ where: { projectId, parentId: null }, data: { tabId: tab.id } });
        }
        return tx.docsTab.findUniqueOrThrow({ where: { id: tab.id }, select: tabSelect });
      }),
    ),
});

export const updateTab = defineOperation({
  name: "tabs.update",
  summary:
    "Rename a docs tab (its slug follows the name) or set what its path shows (`landing`): an `overview` (search and a card per top-level collection; the default), its `first` article in reading order, or a `page`: the article or collection in this tab that `landingPage` names (its slug; required with `page`). A picked page a reader can't read there (unpublished, hidden, restricted, moved to another tab) shows them the overview instead. Or change who can read it (`access` and `groups`) or what the rest see (`noAccess`), as in tabs.create",
  method: "PATCH",
  path: "/tabs/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug, name: tabName.optional(), landing: z.enum(LANDINGS).optional(), landingPage: slug.optional(), ...accessFields }),
  example: { name: "API reference", landing: "page", landingPage: "getting-started" },
  run: async ({ projectId }, input) => {
    if ((input.landing === "page") !== (input.landingPage !== undefined)) {
      throw new OperationError(400, "invalid_input", input.landingPage === undefined ? "Pick the page it shows" : "landingPage goes with landing “page”");
    }
    return tabView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const { id, name } = await lockedTab(tx, projectId, input.slug);
        // Only a new name moves the tab's address (saving its landing page sends the name as it is).
        const renamed = input.name !== undefined && input.name !== name;
        const page =
          input.landingPage === undefined
            ? { landingArticleId: null, landingCollectionId: null }
            : await landingPageIn(tx, projectId, { id, first: (await tabsOf(tx, projectId))[0]?.id === id }, input.landingPage);
        const access = await accessChange(tx, projectId, input);
        return tx.docsTab.update({
          where: { id },
          data: {
            ...(renamed && { name: input.name, slug: await freeDocsSlug(tx, projectId, input.name!, "tab", { id, slug: input.slug }) }),
            ...(input.landing && { landing: input.landing.toUpperCase() as Uppercase<DocsLanding>, ...page }),
            ...(access && { access: access.access, noAccess: access.noAccess, ...(access.groups && { groups: { deleteMany: {}, create: access.groups } }) }),
          },
          select: tabSelect,
        });
      }),
    );
  },
});

/**
 * Before tab `tabId` stops governing them (deleted, or no longer first): its top-level collections, or
 * the articles in no collection, that inherit take its "Who can read", so a tab change never opens
 * what it kept closed (it may narrow); and those that inherit "People without access" take what it
 * came to (a tab that inherits hides) when the tab they go under (`to`; null: none) comes to
 * something else, so it never changes what the rest see of them either. Call it with the project locked.
 */
async function keepTabAccess(tx: Prisma.TransactionClient, projectId: string, tabId: string, what: "collections" | "uncollected", to: string | null) {
  const tab = await tx.docsTab.findUniqueOrThrow({ where: { id: tabId }, select: { access: true, noAccess: true, groups: { select: { groupId: true } } } });
  const next = to ? await tx.docsTab.findUniqueOrThrow({ where: { id: to }, select: { noAccess: true } }) : null;
  const shown = (noAccess: NoAccess | undefined) => (noAccess === "LOCK" ? "LOCK" : "HIDE");
  if (shown(tab.noAccess) !== shown(next?.noAccess)) {
    const where = { projectId, noAccess: "INHERIT" as const };
    if (what === "collections") {
      await tx.collection.updateMany({ where: { ...where, tabId, parentId: null }, data: { noAccess: shown(tab.noAccess) } });
    } else {
      await tx.article.updateMany({ where: { ...where, collectionId: null }, data: { noAccess: shown(tab.noAccess) } });
    }
  }
  if (tab.access === "INHERIT") {
    return;
  }
  if (what === "collections") {
    const ids = (await tx.collection.findMany({ where: { projectId, tabId, parentId: null, access: "INHERIT" }, select: { id: true } })).map((c) => c.id);
    await tx.collection.updateMany({ where: { id: { in: ids } }, data: { access: tab.access } });
    await tx.collectionGroup.createMany({ data: ids.flatMap((collectionId) => tab.groups.map((g) => ({ collectionId, groupId: g.groupId }))), skipDuplicates: true });
  } else {
    const ids = (await tx.article.findMany({ where: { projectId, collectionId: null, access: "INHERIT" }, select: { id: true } })).map((a) => a.id);
    await tx.article.updateMany({ where: { id: { in: ids } }, data: { access: tab.access } });
    await tx.articleGroup.createMany({ data: ids.flatMap((articleId) => tab.groups.map((g) => ({ articleId, groupId: g.groupId }))), skipDuplicates: true });
  }
}

export const reorderTab = defineOperation({
  name: "tabs.reorder",
  summary:
    "Move a docs tab to `position` among the tabs (0 first; left out, last); the others keep their order around it. Readers see the tabs in this order, the first one when they open the docs. The articles in no collection keep who can read them when another tab becomes first",
  method: "POST",
  path: "/tabs/{slug}/reorder",
  scope: "write",
  access: "team",
  input: z.object({ slug, position: position.optional() }),
  example: { position: 0 },
  run: async ({ projectId }, input) =>
    tabView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const { id } = await lockedTab(tx, projectId, input.slug);
        const tabs = await tabsOf(tx, projectId);
        const order = placed(tabs, id, input.position);
        // The first tab governs the articles in no collection: a new one mustn't open them.
        if (tabs[0] && order[0] !== tabs[0].id) {
          await keepTabAccess(tx, projectId, tabs[0].id, "uncollected", order[0] ?? null);
        }
        await renumber(tx, "docs_tab", order);
        return tx.docsTab.findUniqueOrThrow({ where: { id }, select: tabSelect });
      }),
    ),
});

export const deleteTab = defineOperation({
  name: "tabs.delete",
  summary:
    "Delete a docs tab. Its collections go last in the tab before it, with everything in them, and keep who can read them. The first tab is the docs' home (/docs): it can't be deleted while there are others (move another first; 409), and deleting it when it's the only one leaves the docs without tabs",
  method: "DELETE",
  path: "/tabs/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    // Locked, so a collection being saved into it lands first (and moves) or finds it gone.
    const movedTo = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const { id } = await lockedTab(tx, projectId, input.slug);
      const tabs = await tabsOf(tx, projectId);
      const at = tabs.findIndex((s) => s.id === id);
      if (at === 0 && tabs.length > 1) {
        throw new OperationError(409, "first_tab", "Move another tab first: the first tab is your docs' home");
      }
      const target = tabs[at - 1] ?? null;
      const inTab = (tabId: string | null) =>
        tx.collection.findMany({ where: siblingsWhere(projectId, null, tabId), orderBy: siblingOrder, select: { id: true } });
      // What it governed keeps who can read it: its collections, and (the first tab) the articles in none.
      await keepTabAccess(tx, projectId, id, "collections", target?.id ?? null);
      if (at === 0) {
        await keepTabAccess(tx, projectId, id, "uncollected", null);
      }
      const moving = await inTab(id);
      if (moving.length > 0) {
        const staying = target ? await inTab(target.id) : [];
        await tx.collection.updateMany({ where: { tabId: id }, data: { tabId: target?.id ?? null } });
        await renumber(tx, "collection", [...staying, ...moving].map((c) => c.id));
      }
      await tx.docsTab.delete({ where: { id } });
      return target?.slug ?? null;
    });
    // movedTo: where its collections went (null: there are no tabs left).
    return { deleted: input.slug, movedTo };
  },
});
