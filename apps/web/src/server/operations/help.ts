import { isDeepStrictEqual } from "node:util";

import { type ArticleListing, Prisma, prisma } from "@tuti/db";
import { DELETED_ARTICLE_DAYS, enqueue, lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { type Listing, LISTINGS } from "@/lib/article-listing";
import { portalUrl } from "@/lib/hosts";
import { titleSlug } from "@/lib/post-urls";

import { attachMedia, displayDoc, readContent } from "../content";
import { listedArticle } from "../help-queries";
import { searchHelp } from "../help-search";
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
  createdAt: true,
  updatedAt: true,
  collection: { select: { slug: true, name: true } },
} as const;
type ArticleRow = Prisma.ArticleGetPayload<{ select: typeof articleSelect }>;

function articleView(article: ArticleRow, projectSlug: string) {
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
    body: article.body,
    content: displayDoc(article),
    url: `${portalUrl(projectSlug)}/help/${article.slug}`,
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

async function teamCollection(projectId: string, slug: string) {
  const collection = await prisma.collection.findUnique({ where: { projectId_slug: { projectId, slug } }, select: { id: true } });
  if (!collection) {
    throw new OperationError(404, "not_found", `There's no collection “${slug}”`);
  }
  return collection;
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
// "new" and "insights" are the team's pages under /app/<project>/help, so no article can have them.
const freeArticleSlug = (tx: Prisma.TransactionClient, projectId: string, title: string, except?: string) =>
  freeSlug(
    title,
    "article",
    (prefix) =>
      tx.article.findMany({
        where: { projectId, slug: { startsWith: prefix }, deletedAt: null, ...(except && { id: { not: except } }) },
        select: { slug: true },
      }),
    ["new", "insights"],
  );

const freeCollectionSlug = (tx: Prisma.TransactionClient, projectId: string, name: string, except?: string) =>
  freeSlug(name, "collection", (prefix) =>
    tx.collection.findMany({ where: { projectId, slug: { startsWith: prefix }, ...(except && { id: { not: except } }) }, select: { slug: true } }),
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
const newestFirst: Prisma.ArticleRevisionOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

/**
 * Records the article's current version as a revision, unless it's the same as the newest one (a
 * save that changed nothing), and lets the oldest go past ARTICLE_REVISIONS_KEPT. Call it in the
 * transaction that saved the article, with the project locked, so saves can't interleave.
 */
async function recordRevision(tx: Prisma.TransactionClient, articleId: string, authorId: string | null) {
  const article = await tx.article.findUniqueOrThrow({ where: { id: articleId }, select: versionSelect });
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

/**
 * Saves changes to a live article and records them as a revision. Call it with the project locked
 * (lockProject). A draft's slug follows its title; a published one keeps it.
 */
async function saveChanges(
  tx: Prisma.TransactionClient,
  projectId: string,
  article: { id: string; slug: string },
  authorId: string | null,
  changes: { title?: string; text?: ArticleText; collectionId?: string | null; showUpdatedDate?: boolean; listing?: ArticleListing },
) {
  // Read again under the lock: it may have been retitled, published or deleted since.
  const current = await tx.article.findFirst({ where: { id: article.id, deletedAt: null }, select: { title: true, publishedAt: true } });
  if (!current) {
    throw new OperationError(404, "not_found", `There's no article “${article.slug}”`);
  }
  const { title, text, collectionId, showUpdatedDate, listing } = changes;
  const retitled = title !== undefined && title !== current.title && !current.publishedAt;
  const saved = await tx.article.update({
    where: { id: article.id },
    data: {
      ...(title !== undefined && { title }),
      ...(retitled && { slug: await freeArticleSlug(tx, projectId, title, article.id) }),
      ...(text && { body: text.text, content: text.doc }),
      ...(collectionId !== undefined && { collectionId }),
      ...(showUpdatedDate !== undefined && { showUpdatedDate }),
      ...(listing !== undefined && { listing }),
    },
    select: articleSelect,
  });
  if (text) {
    await attachMedia(tx, projectId, text.mediaIds);
  }
  await recordRevision(tx, article.id, authorId);
  return saved;
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
      published: { where: team ? { publishedAt: { not: null }, deletedAt: null } : listedArticle, orderBy: [{ title: "asc" }, { slug: "asc" }] },
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
    const slug = await projectSlug(projectId);
    return {
      articles: articles.slice(0, input.limit).map((article) => articleView(article, slug)),
      nextCursor: articles.length > input.limit ? String(input.cursor + input.limit) : null,
    };
  },
});

export const getArticle = defineOperation({
  name: "articles.get",
  summary: "Get a help center article by its slug (drafts, hidden and AI-only articles only for the team)",
  method: "GET",
  path: "/articles/{slug}",
  scope: "read",
  access: "anyone",
  input: z.object({ slug }),
  run: async ({ actor, projectId }, input) => {
    const article = await findArticle(projectId, input.slug);
    // An article without a page (a draft, hidden or AI only) is as good as missing to everyone but the team.
    const served = article?.publishedAt && SERVED.includes(article.listing);
    if (!article || (!served && !(await isTeam(actor, projectId)))) {
      throw new OperationError(404, "not_found", `There's no article “${input.slug}”`);
    }
    return articleView(article, await projectSlug(projectId));
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
  run: async ({ projectId }, input) => {
    const [results, slug] = await Promise.all([searchHelp(projectId, input.q, input.limit), projectSlug(projectId)]);
    return { results: results.map((result) => ({ ...result, url: `${portalUrl(slug)}/help/${result.slug}` })) };
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
    return articleView(article, await projectSlug(projectId));
  },
});

export const updateArticle = defineOperation({
  name: "articles.update",
  summary:
    "Change a help center article: its title, text, collection or `listing` (everywhere, unlisted, hidden or ai_only) (a draft's slug follows its title; a published one keeps it). Each change is kept as a version (see articles.revisions)",
  method: "PATCH",
  path: "/articles/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug, ...articleFields, title: articleFields.title.optional() }),
  example: { collection: null },
  run: async ({ actor, projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    const text = input.body !== undefined || input.content !== undefined ? await articleText(input, projectId) : undefined;
    const updated = await saving(() =>
      prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const collection = await collectionId(tx, projectId, input.collection);
        return saveChanges(tx, projectId, article, authorOf(actor), {
          title: input.title,
          text,
          collectionId: collection,
          showUpdatedDate: input.showUpdatedDate,
          listing: input.listing && toListing(input.listing),
        });
      }),
    );
    if (updated.publishedAt) {
      await indexArticle(updated.id);
    }
    return articleView(updated, await projectSlug(projectId));
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
  summary: `Restore a help center article. With \`revision\` (from articles.revisions), that version becomes the current one, saved as a new version; a published article shows it at once. Without it, the article most recently deleted with this slug (in the last ${DELETED_ARTICLE_DAYS} days) comes back as a draft, under the same slug unless another article has taken it`,
  method: "POST",
  path: "/articles/{slug}/restore",
  scope: "write",
  access: "team",
  input: z.object({ slug, revision: z.string().trim().min(1).max(100).optional() }),
  run: async ({ actor, projectId }, input) => {
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
    if (restored.publishedAt) {
      await indexArticle(restored.id);
    }
    return articleView(restored, await projectSlug(projectId));
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
    const article = await teamArticle(projectId, input.slug);
    // Only the first publish sets the date. Locked, so a draft's slug can't change as it's published.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await tx.article.updateMany({ where: { id: article.id, publishedAt: null, deletedAt: null }, data: { publishedAt: new Date() } });
    });
    await indexArticle(article.id);
    return articleView(await teamArticle(projectId, input.slug), await projectSlug(projectId));
  },
});

export const unpublishArticle = defineOperation({
  name: "articles.unpublish",
  summary: "Take a help center article off the portal (back to a draft)",
  method: "POST",
  path: "/articles/{slug}/unpublish",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    // Its chunks go with it, so search (and later AI answers) stop using it at once.
    await prisma.$transaction([
      prisma.article.update({ where: { id: article.id }, data: { publishedAt: null } }),
      prisma.articleChunk.deleteMany({ where: { articleId: article.id } }),
    ]);
    return articleView(await teamArticle(projectId, input.slug), await projectSlug(projectId));
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
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await tx.article.updateMany({ where: { id: article.id, deletedAt: null }, data: { deletedAt: new Date(), publishedAt: null } });
      await tx.articleChunk.deleteMany({ where: { articleId: article.id } });
    });
    return { deleted: input.slug };
  },
});

const collectionSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  order: true,
  _count: { select: { articles: { where: { deletedAt: null } } } },
} as const;
type CollectionRow = Prisma.CollectionGetPayload<{ select: typeof collectionSelect }>;
const collectionView = ({ slug, name, description, order, _count }: CollectionRow) => ({
  slug,
  name,
  description,
  order,
  articles: _count.articles,
});

export const listCollections = defineOperation({
  name: "collections.list",
  summary: "List the help center's collections, in order, with how many articles each has",
  method: "GET",
  path: "/collections",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => {
    const collections = await prisma.collection.findMany({
      where: { projectId },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: collectionSelect,
    });
    return { collections: collections.map(collectionView) };
  },
});

export const createCollection = defineOperation({
  name: "collections.create",
  summary: "Add a help center collection (after the others); its slug comes from the name",
  method: "POST",
  path: "/collections",
  scope: "write",
  access: "team",
  input: z.object({ ...collectionFields, description: collectionFields.description.default("") }),
  example: { name: "Getting started", description: "The basics, in five minutes." },
  run: async ({ projectId }, input) =>
    collectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const last = await tx.collection.aggregate({ where: { projectId }, _max: { order: true } });
        return tx.collection.create({
          data: {
            projectId,
            slug: await freeCollectionSlug(tx, projectId, input.name),
            name: input.name,
            description: input.description,
            order: (last._max.order ?? -1) + 1,
          },
          select: collectionSelect,
        });
      }),
    ),
});

export const updateCollection = defineOperation({
  name: "collections.update",
  summary: "Rename a help center collection (its slug follows the name), change its description or its place in the order",
  method: "PATCH",
  path: "/collections/{slug}",
  scope: "write",
  access: "team",
  input: z.object({
    slug,
    name: collectionFields.name.optional(),
    description: collectionFields.description.optional(),
    order: z.number().int().min(0).max(10_000).optional(),
  }),
  example: { name: "Basics" },
  run: async ({ projectId }, input) => {
    const { id } = await teamCollection(projectId, input.slug);
    return collectionView(
      await prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        return tx.collection.update({
          where: { id },
          data: {
            ...(input.name !== undefined && { name: input.name, slug: await freeCollectionSlug(tx, projectId, input.name, id) }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.order !== undefined && { order: input.order }),
          },
          select: collectionSelect,
        });
      }),
    );
  },
});

export const deleteCollection = defineOperation({
  name: "collections.delete",
  summary: "Delete a help center collection; its articles stay, without a collection",
  method: "DELETE",
  path: "/collections/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    const { id } = await teamCollection(projectId, input.slug);
    // Locked, so an article being saved into it lands first (and is let go) or finds it gone.
    await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await tx.collection.deleteMany({ where: { id } });
    });
    return { deleted: input.slug };
  },
});
