import { isDeepStrictEqual } from "node:util";

import { type ArticleListing, Prisma, prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS, enqueue, lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { type Listing, LISTINGS } from "@/lib/article-listing";
import { portalAddress } from "@/server/custom-domains";
import { titleSlug } from "@/lib/post-urls";
import { MAX_READER_GROUPS, readerGroup, visibleArticle } from "@/lib/reader-groups";

import { attachMedia, displayDoc, readContent } from "../content";
import { inTreeOrder, listedArticle, readingOrder } from "../help-queries";
import { searchHelp } from "../help-search";
import { actorGroups } from "../portal-access";
import { isTeam } from "./changelog";
import { saving } from "./create";
import { type Actor, defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/** The help center (Phase 10): articles the team writes, grouped in collections, published on the portal's /help. */

export const MAX_ARTICLE_LENGTH = 50_000;
/**
 * Revisions kept per article; older ones go as new ones come. Every save is a deliberate click
 * (the editor doesn't autosave), so each is kept rather than merged with the last.
 */
export const ARTICLE_REVISIONS_KEPT = 50;

export const MAX_ARTICLE_TITLE = 120;

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
};
const collectionFields = {
  name: z.string().trim().min(1, "Name is required").max(60),
  description: z.string().trim().max(300),
  /**
   * Who may read it (its articles and the collections in it) besides the team: people your app's
   * SSO signs in with one of these groups (the token's `groups`). Empty: everyone.
   */
  groups: z
    .array(readerGroup)
    .max(MAX_READER_GROUPS, `Up to ${MAX_READER_GROUPS} groups`)
    .transform((groups) => [...new Set(groups)]),
};

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
     * Only for the team: a published article's saved changes that readers don't see yet (null if
     * there are none), until articles.publishChanges or articles.discardChanges.
     */
    ...(team && {
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
 * A slug from `text` that `taken` doesn't have: "getting-started", then "getting-started-2", …
 * Call it with the project locked (lockProject), so two saves can't pick the same one.
 */
async function freeSlug(
  text: string,
  fallback: string,
  taken: (prefix: string) => Promise<{ slug: string }[]>,
  reserved: string[] = [],
) {
  const base = titleSlug(text, fallback);
  const used = new Set([...reserved, ...(await taken(base)).map((row) => row.slug)]);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

// Deleted articles don't hold on to their slugs (a restored one takes the next free one if its own is gone).
// "new" and "insights" are the team's pages under /app/<project>/help, and /docs/api is the API
// reference (Tuti's own on the app's domain, and later each portal's from an OpenAPI file), so no article can have them.
const freeArticleSlug = (tx: Prisma.TransactionClient, projectId: string, title: string, except?: string) =>
  freeSlug(
    title,
    "article",
    (prefix) =>
      tx.article.findMany({
        where: { projectId, slug: { startsWith: prefix }, deletedAt: null, ...(except && { id: { not: except } }) },
        select: { slug: true },
      }),
    ["new", "insights", "api"],
  );

const freeCollectionSlug = (tx: Prisma.TransactionClient, projectId: string, name: string, except?: string) =>
  freeSlug(name, "collection", (prefix) =>
    tx.collection.findMany({ where: { projectId, slug: { startsWith: prefix }, ...(except && { id: { not: except } }) }, select: { slug: true } }),
  );

const freeSectionSlug = (tx: Prisma.TransactionClient, projectId: string, name: string, except?: string) =>
  freeSlug(name, "section", (prefix) =>
    tx.docsTab.findMany({ where: { projectId, slug: { startsWith: prefix }, ...(except && { id: { not: except } }) }, select: { slug: true } }),
  );

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
async function recordRevision(tx: Prisma.TransactionClient, articleId: string, authorId: string | null) {
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
    select: { title: true, publishedAt: true, collectionId: true },
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
 * (lockProject). A draft's text changes at once, and its slug follows its title. A published one
 * keeps its slug, and its title, text and collection wait as unpublished changes (unless `publish`,
 * which makes them live with any saved before); its listing and "Updated" setting change at once.
 */
async function saveChanges(
  tx: Prisma.TransactionClient,
  projectId: string,
  article: { id: string; slug: string },
  authorId: string | null,
  changes: { title?: string; text?: ArticleText; collectionId?: string | null; showUpdatedDate?: boolean; listing?: ArticleListing },
  publish = false,
) {
  const current = await lockedArticle(tx, article);
  const { title, text, collectionId, showUpdatedDate, listing } = changes;
  const version = {
    ...(title !== undefined && { title }),
    ...(text && { body: text.text, content: text.doc }),
    ...(collectionId !== undefined && { collectionId }),
  };
  const data: Prisma.ArticleUncheckedUpdateInput = {
    ...(showUpdatedDate !== undefined && { showUpdatedDate }),
    ...(listing !== undefined && { listing }),
  };
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
    Object.assign(
      data,
      version,
      retitled && { slug: await freeArticleSlug(tx, projectId, title, article.id) },
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
      createdAt: true,
      collection: { select: { slug: true, name: true } },
      author: { select: { name: true } },
    },
  });
}

export const listArticles = defineOperation({
  name: "articles.list",
  summary:
    "List help center articles by title: published ones (listed everywhere; the team sees every listing), the team's drafts (latest edited first), or deleted ones the team can still restore (latest deleted first)",
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
      // Not the ones in collections for reader groups the caller isn't in.
      published: {
        where: team ? { publishedAt: { not: null }, deletedAt: null } : { ...listedArticle, ...visibleArticle(await actorGroups(actor, projectId)) },
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
    "Get a help center article by its slug (drafts, hidden and AI-only articles only for the team). The team also gets its unpublished `changes`",
  method: "GET",
  path: "/articles/{slug}",
  scope: "read",
  access: "anyone",
  input: z.object({ slug }),
  run: async ({ actor, projectId }, input) => {
    const [article, team] = await Promise.all([findArticle(projectId, input.slug), isTeam(actor, projectId)]);
    // An article without a page (a draft, hidden or AI only) is as good as missing to everyone but the team.
    const served = article?.publishedAt && SERVED.includes(article.listing);
    // Nor one in a collection for reader groups they aren't in.
    const visible = async (id: string) =>
      (await prisma.article.count({ where: { id, ...visibleArticle(await actorGroups(actor, projectId)) } })) > 0;
    if (!article || (!team && (!served || !(await visible(article.id))))) {
      throw new OperationError(404, "not_found", `There's no article “${input.slug}”`);
    }
    return articleView(article, await portalOf(projectId), team);
  },
});

export const searchArticles = defineOperation({
  name: "articles.search",
  summary: "Search the published help center articles: best matches first, each with the passage that matched",
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
    const [results, portal] = await Promise.all([searchHelp(projectId, input.q, input.limit, await actorGroups(actor, projectId)), portalOf(projectId)]);
    return { results: results.map((result) => ({ ...result, url: `${portal}/docs/${result.slug}` })) };
  },
});

export const createArticle = defineOperation({
  name: "articles.create",
  summary: "Write a help center article (a draft until it's published); its slug comes from the title",
  method: "POST",
  path: "/articles",
  scope: "write",
  access: "team",
  input: z.object(articleFields),
  example: { title: "Getting started", body: "Create a board, then share your portal.", collection: "basics" },
  run: async ({ actor, projectId }, input) => {
    // Before anything is written: a lookup failing after would fail a request that did its work.
    const portal = await portalOf(projectId);
    const text = await articleText(input, projectId);
    const article = await saving(() =>
      prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const collection = await collectionId(tx, projectId, input.collection);
        const created = await tx.article.create({
          data: {
            projectId,
            slug: await freeArticleSlug(tx, projectId, input.title),
            title: input.title,
            body: text.text,
            content: text.doc,
            collectionId: collection ?? null,
            order: await lastArticle(tx, projectId, collection ?? null),
            showUpdatedDate: input.showUpdatedDate,
            listing: input.listing && toListing(input.listing),
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
    "Change a help center article: its title, text, collection or `listing` (everywhere, unlisted, hidden or ai_only) (a draft's slug follows its title; a published one keeps it). Each change is kept as a version (see articles.revisions). On a published article, changes to the title, text and collection are kept as unpublished `changes` (readers see the published version until articles.publishChanges); with `publish: true` they go live at once, with any changes saved before. The listing and showUpdatedDate change at once",
  method: "PATCH",
  path: "/articles/{slug}",
  scope: "write",
  access: "team",
  input: z.object({
    slug,
    ...articleFields,
    title: articleFields.title.optional(),
    /** On a published article: make the changes live at once instead of keeping them unpublished. Ignored on a draft. */
    publish: z.boolean().optional(),
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
          },
          input.publish,
        );
      }),
    );
    if (updated.publishedAt && input.publish) {
      await indexArticle(updated.id);
    }
    return articleView(updated, portal, true);
  },
});

export const listRevisions = defineOperation({
  name: "articles.revisions",
  summary: `A help center article's saved versions, newest (the current one) first, with who saved each and its text (the latest ${ARTICLE_REVISIONS_KEPT} are kept)`,
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
  summary: `Restore a help center article. With \`revision\` (from articles.revisions), that version becomes the current one, saved as a new version (on a published article, as unpublished \`changes\`, like any save). Without it, the article most recently deleted with this slug (in the last ${DELETED_ARTICLE_DAYS} days) comes back as a draft, under the same slug unless another article has taken it`,
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
        if (deletedAt) {
          // Back as a draft (deleting unpublished it), under its slug unless another article has it now.
          await tx.article.updateMany({
            where: { id, deletedAt: { not: null } },
            data: { deletedAt: null, slug: await freeArticleSlug(tx, projectId, article.slug, id) },
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
  summary: "Publish a help center article on the portal",
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
    "Publish a help center article's unpublished `changes` (see articles.update): readers, search and AI answers get them. Without changes it does nothing",
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
    "Drop a help center article's unpublished `changes`: it's back to the published version (saved as a new version, so the changes stay in articles.revisions). Without changes it does nothing",
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
  summary: "Take a help center article off the portal (back to a draft, with its unpublished changes as the draft's text)",
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
  summary: `Delete a help center article; the team can restore it (with articles.restore) for ${DELETED_ARTICLE_DAYS} days`,
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
    "Move a help center article within its collection, or into another (`collection`, null for none), at `position` (0 first; left out, last); the others keep their order around it. Readers list articles in this order. A move to another collection goes live at once, on a published article too (its unpublished changes move with it), and is kept as a version",
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
  parent: { select: { slug: true, tab: { select: { slug: true } } } },
  tab: { select: { slug: true } },
  groups: true,
  _count: { select: { articles: { where: { deletedAt: null } } } },
} as const;
type CollectionRow = Prisma.CollectionGetPayload<{ select: typeof collectionSelect }>;
const collectionView = ({ slug, name, description, order, parent, tab, groups, _count }: CollectionRow) => ({
  slug,
  name,
  description,
  /** Reader groups it's for (besides the team); empty: everyone. One inside another is also limited by its parent's. */
  groups,
  /** The collection it's in (its slug), or null at the top level. */
  parent: parent?.slug ?? null,
  /** The section it's in (a collection in another is in its parent's), or null if the help center has no sections. */
  section: (parent ? parent.tab : tab)?.slug ?? null,
  order,
  articles: _count.articles,
});

const siblingOrder: Prisma.CollectionOrderByWithRelationInput[] = [{ order: "asc" }, { name: "asc" }];
const sectionOrder: Prisma.DocsTabOrderByWithRelationInput[] = [{ order: "asc" }, { name: "asc" }];

/** Collection `slug`, read under the project's lock (it may have been renamed or deleted since the caller looked). */
async function lockedCollection(tx: Prisma.TransactionClient, projectId: string, slug: string) {
  const collection = await tx.collection.findUnique({
    where: { projectId_slug: { projectId, slug } },
    select: { id: true, name: true, parentId: true, tabId: true, parent: { select: { tabId: true } } },
  });
  if (!collection) {
    throw new OperationError(404, "not_found", `There's no collection “${slug}”`);
  }
  return collection;
}

/**
 * The id of collection `slug` (null: the top level) for `collection` (undefined: a new one) to go
 * in. Call it with the project locked. Collections go 2 levels deep at most: the parent must be at
 * the top level, and a collection with collections in it stays there. That also rules out cycles.
 */
async function parentFor(
  tx: Prisma.TransactionClient,
  projectId: string,
  collection: { id: string; name: string } | undefined,
  slug: string | null,
) {
  if (slug === null) {
    return null;
  }
  const parent = await tx.collection.findUnique({
    where: { projectId_slug: { projectId, slug } },
    select: { id: true, name: true, parentId: true },
  });
  if (!parent) {
    throw new OperationError(400, "invalid_input", `There's no collection “${slug}”`);
  }
  if (parent.id === collection?.id) {
    throw new OperationError(400, "invalid_input", "A collection can't go inside itself");
  }
  if (parent.parentId !== null) {
    throw new OperationError(400, "invalid_input", `Collections go 2 levels deep at most, and “${parent.name}” is inside another`);
  }
  if (collection && (await tx.collection.count({ where: { parentId: collection.id } })) > 0) {
    throw new OperationError(400, "invalid_input", `Collections go 2 levels deep at most, and “${collection.name}” has collections in it`);
  }
  return parent.id;
}

/** The collections in `parentId`, or at the top level (`parentId` null) in section `tabId`. */
const siblingsWhere = (projectId: string, parentId: string | null, tabId: string | null): Prisma.CollectionWhereInput =>
  parentId === null ? { projectId, parentId, tabId } : { projectId, parentId };

/**
 * Puts collection `id` in `parentId` (or at the top level of section `tabId`, when `parentId`
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

/** The project's sections in order. Read with the project locked when the answer decides where something goes. */
const sectionsOf = (tx: Prisma.TransactionClient, projectId: string) =>
  tx.docsTab.findMany({ where: { projectId }, orderBy: sectionOrder, select: { id: true, slug: true, name: true } });

/**
 * The section a collection at the top level goes in: section `slug` if one is named (only at the
 * top level: one inside another is in its parent's), else `fallback`, else the first one (null when
 * the help center has none). Call it with the project locked.
 */
async function sectionFor(
  tx: Prisma.TransactionClient,
  projectId: string,
  { slug, parentId, fallback }: { slug: string | undefined; parentId: string | null; fallback?: string | null },
) {
  if (parentId !== null) {
    if (slug !== undefined) {
      throw new OperationError(400, "invalid_input", "A collection inside another is in that one's section, so it can't have its own");
    }
    return null;
  }
  const sections = await sectionsOf(tx, projectId);
  if (slug !== undefined) {
    const section = sections.find((s) => s.slug === slug);
    if (!section) {
      throw new OperationError(400, "invalid_input", `There's no section “${slug}”`);
    }
    return section.id;
  }
  return sections.find((s) => s.id === fallback)?.id ?? sections[0]?.id ?? null;
}

/**
 * Where collection `collection` goes for `parent` (null: the top level; undefined: where it is) and
 * `section`: at the top level, the named section, else the one it's in (or its parent's, coming out
 * of it). Call it with the project locked.
 */
async function placeFor(
  tx: Prisma.TransactionClient,
  projectId: string,
  collection: Awaited<ReturnType<typeof lockedCollection>>,
  input: { parent?: string | null; section?: string },
) {
  const parentId = input.parent === undefined ? collection.parentId : await parentFor(tx, projectId, collection, input.parent);
  const fallback = collection.parentId === null ? collection.tabId : (collection.parent?.tabId ?? null);
  return { parentId, tabId: await sectionFor(tx, projectId, { slug: input.section, parentId, fallback }) };
}

export const listCollections = defineOperation({
  name: "collections.list",
  summary:
    "List the help center's collections in order (by section, each top-level one, then the ones in it), with the collection each is in (`parent`), its section and how many articles each has",
  method: "GET",
  path: "/collections",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => {
    const collections = await prisma.collection.findMany({ where: { projectId }, orderBy: readingOrder, select: collectionSelect });
    return { collections: inTreeOrder(collections).map(collectionView) };
  },
});

export const createCollection = defineOperation({
  name: "collections.create",
  summary:
    "Add a help center collection, at the top level (in `section`; left out, the first one, if the help center has sections) or in another collection (`parent`; 2 levels deep at most), after the others there; its slug comes from the name. `groups` makes it (and what's in it) for those reader groups only (from your app's SSO token), besides the team",
  method: "POST",
  path: "/collections",
  scope: "write",
  access: "team",
  input: z.object({
    ...collectionFields,
    description: collectionFields.description.default(""),
    groups: collectionFields.groups.default([]),
    parent: slug.nullable().optional(),
    section: slug.optional(),
  }),
  example: { name: "Getting started", description: "The basics, in five minutes." },
  run: async ({ projectId }, input) =>
    collectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const parentId = await parentFor(tx, projectId, undefined, input.parent ?? null);
        const tabId = await sectionFor(tx, projectId, { slug: input.section, parentId });
        const last = await tx.collection.aggregate({ where: siblingsWhere(projectId, parentId, tabId), _max: { order: true } });
        return tx.collection.create({
          data: {
            projectId,
            parentId,
            tabId,
            slug: await freeCollectionSlug(tx, projectId, input.name),
            name: input.name,
            description: input.description,
            groups: input.groups,
            order: (last._max.order ?? -1) + 1,
          },
          select: collectionSelect,
        });
      }),
    ),
});

export const updateCollection = defineOperation({
  name: "collections.update",
  summary:
    "Rename a help center collection (its slug follows the name), change its description, move it into another collection (`parent`, null for the top level; it goes last there), to another section (`section`, at the top level), set who may read it (`groups`: reader groups from your app's SSO token; empty, everyone) or set its `order` among its siblings. To move it to a place, see collections.reorder",
  method: "PATCH",
  path: "/collections/{slug}",
  scope: "write",
  access: "team",
  input: z.object({
    slug,
    name: collectionFields.name.optional(),
    description: collectionFields.description.optional(),
    groups: collectionFields.groups.optional(),
    parent: slug.nullable().optional(),
    section: slug.optional(),
    order: position.optional(),
  }),
  example: { name: "Basics", parent: null },
  run: async ({ projectId }, input) =>
    collectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const collection = await lockedCollection(tx, projectId, input.slug);
        const { id } = collection;
        if (input.parent !== undefined || input.section !== undefined) {
          const place = await placeFor(tx, projectId, collection, input);
          if (place.parentId !== collection.parentId || place.tabId !== collection.tabId) {
            await placeCollection(tx, projectId, id, place);
          }
        }
        return tx.collection.update({
          where: { id },
          data: {
            ...(input.name !== undefined && { name: input.name, slug: await freeCollectionSlug(tx, projectId, input.name, id) }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.groups !== undefined && { groups: input.groups }),
            ...(input.order !== undefined && { order: input.order }),
          },
          select: collectionSelect,
        });
      }),
    ),
});

export const reorderCollection = defineOperation({
  name: "collections.reorder",
  summary:
    "Move a help center collection among its siblings, into another collection (`parent`, null for the top level; 2 levels deep at most) or to another section (`section`, at the top level; left out, the one it's in, or was in through its parent), at `position` (0 first; left out, last); the others keep their order around it. Readers list collections in this order",
  method: "POST",
  path: "/collections/{slug}/reorder",
  scope: "write",
  access: "team",
  input: z.object({ slug, parent: slug.nullable().optional(), section: slug.optional(), position: position.optional() }),
  example: { parent: null, position: 0 },
  run: async ({ projectId }, input) =>
    collectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const collection = await lockedCollection(tx, projectId, input.slug);
        await placeCollection(tx, projectId, collection.id, await placeFor(tx, projectId, collection, input), input.position);
        return tx.collection.findUniqueOrThrow({ where: { id: collection.id }, select: collectionSelect });
      }),
    ),
});

export const deleteCollection = defineOperation({
  name: "collections.delete",
  summary: "Delete a help center collection; the collections in it move up a level, in its place, and its articles stay, without a collection",
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
        // Only a top-level collection has some in it, so they come up to the top level, in its section.
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

const sectionSelect = { id: true, slug: true, name: true, order: true, _count: { select: { collections: true } } } as const;
type SectionRow = Prisma.DocsTabGetPayload<{ select: typeof sectionSelect }>;
const sectionView = ({ slug, name, order, _count }: SectionRow) => ({
  slug,
  name,
  order,
  /** Its top-level collections (each with the ones in it). */
  collections: _count.collections,
});
const sectionName = z.string().trim().min(1, "Name is required").max(40);

/** Section `slug`, read under the project's lock. */
async function lockedSection(tx: Prisma.TransactionClient, projectId: string, slug: string) {
  const section = await tx.docsTab.findUnique({ where: { projectId_slug: { projectId, slug } }, select: { id: true } });
  if (!section) {
    throw new OperationError(404, "not_found", `There's no section “${slug}”`);
  }
  return section;
}

export const listSections = defineOperation({
  name: "sections.list",
  summary:
    "List the help center's sections in order: readers see each as a tab, with its collections. Without sections, the help center is one page",
  method: "GET",
  path: "/sections",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({
    sections: (await prisma.docsTab.findMany({ where: { projectId }, orderBy: sectionOrder, select: sectionSelect })).map(sectionView),
  }),
});

export const createSection = defineOperation({
  name: "sections.create",
  summary:
    "Add a help center section (a tab for readers), after the others; its slug comes from the name. The first one takes every top-level collection: once there are sections, each top-level collection is in one",
  method: "POST",
  path: "/sections",
  scope: "write",
  access: "team",
  input: z.object({ name: sectionName }),
  example: { name: "Guides" },
  run: async ({ projectId }, input) =>
    sectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const last = await tx.docsTab.aggregate({ where: { projectId }, _max: { order: true } });
        const section = await tx.docsTab.create({
          data: { projectId, slug: await freeSectionSlug(tx, projectId, input.name), name: input.name, order: (last._max.order ?? -1) + 1 },
          select: { id: true },
        });
        // The first section: the collections there are go in it, in their order.
        if (last._max.order === null) {
          await tx.collection.updateMany({ where: { projectId, parentId: null }, data: { tabId: section.id } });
        }
        return tx.docsTab.findUniqueOrThrow({ where: { id: section.id }, select: sectionSelect });
      }),
    ),
});

export const updateSection = defineOperation({
  name: "sections.update",
  summary: "Rename a help center section; its slug follows the name",
  method: "PATCH",
  path: "/sections/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug, name: sectionName }),
  example: { name: "API reference" },
  run: async ({ projectId }, input) =>
    sectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const { id } = await lockedSection(tx, projectId, input.slug);
        return tx.docsTab.update({
          where: { id },
          data: { name: input.name, slug: await freeSectionSlug(tx, projectId, input.name, id) },
          select: sectionSelect,
        });
      }),
    ),
});

export const reorderSection = defineOperation({
  name: "sections.reorder",
  summary:
    "Move a help center section to `position` among the sections (0 first; left out, last); the others keep their order around it. Readers see the tabs in this order, the first one when they open the help center",
  method: "POST",
  path: "/sections/{slug}/reorder",
  scope: "write",
  access: "team",
  input: z.object({ slug, position: position.optional() }),
  example: { position: 0 },
  run: async ({ projectId }, input) =>
    sectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const { id } = await lockedSection(tx, projectId, input.slug);
        await renumber(tx, "docs_tab", placed(await sectionsOf(tx, projectId), id, input.position));
        return tx.docsTab.findUniqueOrThrow({ where: { id }, select: sectionSelect });
      }),
    ),
});

export const deleteSection = defineOperation({
  name: "sections.delete",
  summary:
    "Delete a help center section. Its collections go last in the section before it (the one after, for the first), with everything in them; deleting the last section leaves the help center without sections",
  method: "DELETE",
  path: "/sections/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    // Locked, so a collection being saved into it lands first (and moves) or finds it gone.
    const movedTo = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const { id } = await lockedSection(tx, projectId, input.slug);
      const sections = await sectionsOf(tx, projectId);
      const at = sections.findIndex((s) => s.id === id);
      const target = sections[at - 1] ?? sections[at + 1] ?? null;
      const inSection = (tabId: string | null) =>
        tx.collection.findMany({ where: siblingsWhere(projectId, null, tabId), orderBy: siblingOrder, select: { id: true } });
      const moving = await inSection(id);
      if (moving.length > 0) {
        const staying = target ? await inSection(target.id) : [];
        await tx.collection.updateMany({ where: { tabId: id }, data: { tabId: target?.id ?? null } });
        await renumber(tx, "collection", [...staying, ...moving].map((c) => c.id));
      }
      await tx.docsTab.delete({ where: { id } });
      return target?.slug ?? null;
    });
    // movedTo: where its collections went (null: there are no sections left).
    return { deleted: input.slug, movedTo };
  },
});
