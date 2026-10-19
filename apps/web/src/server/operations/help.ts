import { type Prisma, prisma } from "@tuti/db";
import { enqueue, lockProject } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { portalUrl } from "@/lib/hosts";
import { titleSlug } from "@/lib/post-urls";

import { attachMedia, displayDoc, readContent } from "../content";
import { searchHelp } from "../help-search";
import { isTeam } from "./changelog";
import { saving } from "./create";
import { defineOperation, OperationError } from "./define";
import { projectSlug } from "./read";

/** The help center (Phase 10): articles the team writes, grouped in collections, published on the portal's /help. */

export const MAX_ARTICLE_LENGTH = 50_000;

const slug = z.string().trim().min(1).max(80);
const articleFields = {
  title: z.string().trim().min(3, "Title is too short").max(120),
  /** Plain text; ignored when `content` is sent. */
  body: z.string().max(MAX_ARTICLE_LENGTH).optional(),
  /** Rich content (the editor's JSON, "article" profile). */
  content: z.unknown().optional(),
  /** The collection's slug, or null for none. */
  collection: slug.nullable().optional(),
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
    collection: article.collection,
    body: article.body,
    content: displayDoc(article),
    url: `${portalUrl(projectSlug)}/help/${article.slug}`,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };
}

async function teamArticle(projectId: string, slug: string) {
  const article = await prisma.article.findUnique({ where: { projectId_slug: { projectId, slug } }, select: articleSelect });
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

// "new" is the team's new-article page (/app/<project>/help/new), so no article can have it.
const freeArticleSlug = (tx: Prisma.TransactionClient, projectId: string, title: string, except?: string) =>
  freeSlug(
    title,
    "article",
    (prefix) =>
      tx.article.findMany({ where: { projectId, slug: { startsWith: prefix }, ...(except && { id: { not: except } }) }, select: { slug: true } }),
    ["new"],
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

export const listArticles = defineOperation({
  name: "articles.list",
  summary: "List help center articles by title: published ones, or the team's drafts (latest edited first)",
  method: "GET",
  path: "/articles",
  scope: "read",
  access: "anyone",
  input: z.object({
    status: z.enum(["published", "draft"]).default("published"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  example: { status: "published", limit: 20 },
  run: async ({ actor, projectId }, input) => {
    if (input.status === "draft" && !(await isTeam(actor, projectId))) {
      throw new OperationError(403, "forbidden", "Only the project's team sees drafts");
    }
    const published = input.status === "published";
    const articles = await prisma.article.findMany({
      where: { projectId, publishedAt: published ? { not: null } : null },
      orderBy: published ? [{ title: "asc" }, { slug: "asc" }] : [{ updatedAt: "desc" }, { slug: "asc" }],
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
  summary: "Get a help center article by its slug (drafts only for the team)",
  method: "GET",
  path: "/articles/{slug}",
  scope: "read",
  access: "anyone",
  input: z.object({ slug }),
  run: async ({ actor, projectId }, input) => {
    const article = await prisma.article.findUnique({ where: { projectId_slug: { projectId, slug: input.slug } }, select: articleSelect });
    // A draft is as good as missing to everyone but the team.
    if (!article || (!article.publishedAt && !(await isTeam(actor, projectId)))) {
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
            createdById: actor.kind === "user" ? actor.userId : actor.createdById,
          },
          select: articleSelect,
        });
        await attachMedia(tx, projectId, text.mediaIds);
        return created;
      }),
    );
    return articleView(article, await projectSlug(projectId));
  },
});

export const updateArticle = defineOperation({
  name: "articles.update",
  summary: "Change a help center article: its title, text or collection (a draft's slug follows its title; a published one keeps it)",
  method: "PATCH",
  path: "/articles/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug, title: articleFields.title.optional(), body: articleFields.body, content: articleFields.content, collection: articleFields.collection }),
  example: { collection: null },
  run: async ({ projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    const text = input.body !== undefined || input.content !== undefined ? await articleText(input, projectId) : null;
    const updated = await saving(() =>
      prisma.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        const collection = await collectionId(tx, projectId, input.collection);
        // Read again under the lock: it may have been retitled or published since.
        const current = await tx.article.findUnique({ where: { id: article.id }, select: { title: true, publishedAt: true } });
        if (!current) {
          throw new OperationError(404, "not_found", `There's no article “${input.slug}”`);
        }
        const retitled = input.title !== undefined && input.title !== current.title && !current.publishedAt;
        const saved = await tx.article.update({
          where: { id: article.id },
          data: {
            ...(input.title !== undefined && { title: input.title }),
            ...(retitled && { slug: await freeArticleSlug(tx, projectId, input.title!, article.id) }),
            ...(text && { body: text.text, content: text.doc }),
            ...(collection !== undefined && { collectionId: collection }),
          },
          select: articleSelect,
        });
        if (text) {
          await attachMedia(tx, projectId, text.mediaIds);
        }
        return saved;
      }),
    );
    if (updated.publishedAt) {
      await indexArticle(updated.id);
    }
    return articleView(updated, await projectSlug(projectId));
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
      await tx.article.updateMany({ where: { id: article.id, publishedAt: null }, data: { publishedAt: new Date() } });
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
  summary: "Delete a help center article",
  method: "DELETE",
  path: "/articles/{slug}",
  scope: "write",
  access: "team",
  input: z.object({ slug }),
  run: async ({ projectId }, input) => {
    const article = await teamArticle(projectId, input.slug);
    await prisma.article.delete({ where: { id: article.id } });
    return { deleted: input.slug };
  },
});

const collectionSelect = { id: true, slug: true, name: true, description: true, order: true, _count: { select: { articles: true } } } as const;
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
