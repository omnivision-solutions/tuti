import { type Doc, toMarkdown } from "@tuti/content";
import { type DocsLanding, type NoAccess, type Prisma, prisma } from "@tuti/db";
import { cache } from "react";

import { ancestry } from "@/lib/collection-tree";
import { describeAccess, type Level, locks, type NamedLevel, readable, type Reader, restricted } from "@/lib/read-access";
import { levelSelect, visibleArticle } from "@/lib/reader-groups";

import { displayDoc } from "./content";
import { portalAddress } from "./custom-domains";
import { mediaUrls } from "./media-urls";
import { currentReader } from "./portal-access";

/** Reads for the docs pages: the team's editor and the portal. */

/**
 * Collections in reading order: each top-level one, then the ones in it (each followed by the ones
 * in it). `sorted` is by order, then name.
 */
export function inTreeOrder<T extends { id: string; parentId: string | null }>(sorted: T[]): T[] {
  const under = (parentId: string | null): T[] => sorted.filter((c) => c.parentId === parentId).flatMap((c) => [c, ...under(c.id)]);
  return under(null);
}

/**
 * Collections sorted for inTreeOrder: by tab (the tabs' order), then by their order there. The
 * ones inside others have no tab of their own, and inTreeOrder only keeps their order among siblings.
 */
export const readingOrder: Prisma.CollectionOrderByWithRelationInput[] = [
  { tab: { order: "asc" } },
  { tab: { name: "asc" } },
  { order: "asc" },
  { name: "asc" },
];

/** A collection's name with the ones it's in ("Billing › Invoices"); `rows` are its project's. */
export const collectionPath = (rows: { id: string; parentId: string | null; name: string }[], id: string) =>
  ancestry(rows, id)
    .map((c) => c.name)
    .reverse()
    .join(" › ");

/** The editor's collection picker: in reading order, a collection in others named with them ("Billing › Invoices"). */
export async function collectionOptions(projectId: string) {
  const collections = await prisma.collection.findMany({ where: { projectId }, orderBy: readingOrder, select: { id: true, parentId: true, slug: true, name: true } });
  return inTreeOrder(collections).map((c) => ({ slug: c.slug, name: collectionPath(collections, c.id) }));
}

/** A level's groups by name (`names`: the project's groups' names by key), for the team. */
export const namedLevel = (level: Level, names: Map<string, string>): NamedLevel => ({
  access: level.access,
  groups: level.groups.map((g) => names.get(g.group.key) ?? g.group.key),
});

/**
 * For the team's "Who can read": the project's groups, and who may read a page that inherits under
 * each tab and collection (with everything above it), in words, by slug (tabs and collections share
 * them; "" is the top level of docs without tabs). Articles in no collection are under the first tab.
 */
export const accessChoices = cache(async (projectId: string) => {
  const [tabs, collections, groups, project] = await Promise.all([
    prisma.docsTab.findMany({ where: { projectId }, orderBy: tabOrder, select: { id: true, slug: true, name: true, ...levelSelect } }),
    prisma.collection.findMany({ where: { projectId }, select: { id: true, parentId: true, tabId: true, slug: true, ...levelSelect } }),
    prisma.readerGroup.findMany({ where: { projectId }, orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true } }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } }),
  ]);
  const names = new Map(groups.map((g) => [g.key, g.name]));
  const tabOf = new Map(tabs.map((tab) => [tab.id, tab]));
  // Each tab's and collection's levels, top down, by slug.
  const chains: [string, ((Level & { noAccess: NoAccess }) | undefined)[]][] = [
    ["", []],
    ...tabs.map((tab): [string, [typeof tab]] => [tab.slug, [tab]]),
    ...collections.map((c): [string, ((typeof tabs)[number] | (typeof c) | undefined)[]] => {
      const up = ancestry(collections, c.id);
      const tabId = up.at(-1)?.tabId;
      return [c.slug, [tabId ? tabOf.get(tabId) : undefined, ...up.toReversed()]];
    }),
  ];
  const words = (chain: (Level | undefined)[]) => describeAccess(chain.flatMap((level) => (level ? [namedLevel(level, names)] : [])));
  const inherits: Record<string, string> = Object.fromEntries(chains.map(([slug, chain]) => [slug, words(chain)]));
  /** What the rest see of a page that inherits "People without access" there. */
  const shows: Record<string, "lock" | "hide"> = Object.fromEntries(chains.map(([slug, chain]) => [slug, locks(...chain) ? "lock" : "hide"]));
  return {
    groups,
    inherits,
    shows,
    firstTab: tabs[0] ? { slug: tabs[0].slug, name: tabs[0].name } : null,
    /** The portal's address, for "Preview as a reader". */
    portal: await portalAddress(project.slug),
  };
});

export type AccessChoices = Awaited<ReturnType<typeof accessChoices>>;

/**
 * What readers may see: published articles, as far as each one's listing lets them. A deleted
 * article is never published (a check constraint), so `publishedAt` alone would do; `deletedAt`
 * says so where it's read. Raw SQL readers (docs-search.ts, docs-readers.ts, docs-insights.ts)
 * spell the same out.
 */
const published = { publishedAt: { not: null }, deletedAt: null } as const;
/** The order tabs are in: the first is /docs, and has the articles in no collection. */
export const tabOrder: Prisma.DocsTabOrderByWithRelationInput[] = [{ order: "asc" }, { name: "asc" }];

/** "Who can read" the project's first tab, which the articles in no collection are under (null without tabs). */
export const firstTabLevel = (projectId: string) =>
  prisma.docsTab.findFirst({ where: { projectId }, orderBy: tabOrder, select: levelSelect });

/** Articles `reader` may read (visibleArticle, with the project's first tab looked up); everything for the team. */
export async function readableArticle(projectId: string, reader: Reader): Promise<Prisma.ArticleWhereInput> {
  return reader === null ? {} : visibleArticle(reader, await firstTabLevel(projectId));
}

/** In the docs' lists, search, the sitemap and llms.txt: listed everywhere. */
export const listedArticle = { ...published, listing: "EVERYWHERE" } satisfies Prisma.ArticleWhereInput;
/** Readable at its link (its page and .md): listed everywhere, or unlisted. Hidden and AI-only articles have no page. */
export const servedArticle = { ...published, listing: { in: ["EVERYWHERE", "UNLISTED"] } } satisfies Prisma.ArticleWhereInput;

/** An article in a list: `locked` when this reader may not read it but sees its title with a lock. */
export type DocsArticleLink = { slug: string; title: string; locked?: true };

export type DocsCollection = {
  slug: string;
  name: string;
  /** Empty when it's locked. */
  description: string;
  /** Its Lucide icon's name, or null. */
  icon: string | null;
  articles: DocsArticleLink[];
  /** The collections in it, in order. */
  collections: DocsCollection[];
  /** This reader may not read it, but sees its name with a lock (and nothing in it). */
  locked?: true;
};

/**
 * A tab of the docs for readers, with its collections and, on the first, the articles in none.
 * `landing`: what its path shows (tabLanding), with `page` the slug of the article or collection
 * picked (null when there's none, or it's deleted).
 */
export type DocsTabView = {
  slug: string;
  name: string;
  collections: DocsCollection[];
  uncollected: DocsArticleLink[];
  landing: DocsLanding;
  page: string | null;
  /** This reader may not read it, but sees its name with a lock (and nothing in it). */
  locked?: true;
};

/**
 * The portal's /docs (and the widget's, and llms.txt): the top-level collections in order, each with
 * its listed articles in order and then the collections in it, and the listed articles in none.
 * Collections without a listed article (in them or in the ones in them) are left out. `tabs`
 * splits the same by tab, leaving out the ones with nothing to read; it's empty when the docs
 * have no tabs. The first tab has the articles in no collection, and is at /docs (`home`: its
 * slug, whether or not it has anything to read; null without tabs). Once per request for the
 * reader: the docs pages, their tabs row and their tree share it. `indexable` (llms.txt) leaves out
 * the articles whose team blocked search indexing.
 *
 * What isn't for this reader is left out, unless "People without access" shows it with a lock
 * (`locks`): then it's there by its title (a tab's or collection's name and icon) with `locked`,
 * and nothing in it, as long as the team would find something to read there. Not with `locks:
 * false` (search engines and AI tools get no locks). `signedIn`: whether this reader is signed in,
 * for what a locked page tells them.
 */
export const docsContents = cache(async (projectSlug: string, options: { reader?: Reader; indexable?: boolean; locks?: boolean } = {}) => {
  const order: Prisma.ArticleOrderByWithRelationInput[] = [{ order: "asc" }, { title: "asc" }];
  const listed = { ...listedArticle, ...(options.indexable && { noindex: false }) };
  const articleSelect = { where: listed, orderBy: order, select: { projectId: true, slug: true, title: true, ...levelSelect } } as const;
  const [rows, uncollected, tabRows] = await Promise.all([
    prisma.collection.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: readingOrder,
      select: {
        id: true,
        projectId: true,
        parentId: true,
        tabId: true,
        slug: true,
        name: true,
        description: true,
        icon: true,
        ...levelSelect,
        articles: articleSelect,
      },
    }),
    prisma.article.findMany({ ...articleSelect, where: { ...listed, project: { slug: projectSlug }, collectionId: null } }),
    prisma.docsTab.findMany({
      where: { project: { slug: projectSlug } },
      orderBy: tabOrder,
      select: {
        id: true,
        projectId: true,
        slug: true,
        name: true,
        ...levelSelect,
        landing: true,
        landingArticle: { select: { slug: true, deletedAt: true } },
        landingCollection: { select: { slug: true } },
      },
    }),
  ]);
  type Row = (typeof rows)[number];
  // What's for some readers only is left out for everyone else (`reader`, or whoever's reading): a
  // page needs its tab, every collection it's in and itself to let them through.
  const levels = [...tabRows, ...rows, ...rows.flatMap((row) => row.articles), ...uncollected];
  // Any level is a row of the project: only asked when there's one that's restricted.
  const reader = options.reader !== undefined ? options.reader : restricted(levels) ? await currentReader(levels[0]!.projectId) : null;
  const tabOf = new Map(tabRows.map((tab) => [tab.id, tab]));
  const withLocks = options.locks !== false;
  // A collection's levels, top down: its top-level one's tab, the ones it's in, itself.
  const levelsOf = (row: Row) => {
    const up = ancestry(rows, row.id);
    const tabId = up.at(-1)?.tabId;
    return [tabId ? tabOf.get(tabId) : undefined, ...up.toReversed()];
  };
  // Whether the team would find something to read in it.
  const hasArticles = (row: Row): boolean => row.articles.length > 0 || rows.some((child) => child.parentId === row.id && hasArticles(child));
  const allowed = (row: Row) => readable(reader, row, row.parentId === null && row.tabId ? tabOf.get(row.tabId) : null);
  // In a collection (or tab) this reader may read (`above`: its levels): the articles they may, and the locked ones by title.
  const articlesFor = (articles: Row["articles"], above: Parameters<typeof locks>): DocsArticleLink[] =>
    articles.flatMap(({ slug, title, ...level }) =>
      readable(reader, level) ? [{ slug, title }] : withLocks && locks(...above, level) ? [{ slug, title, locked: true as const }] : [],
    );
  // Left out (null) when there's nothing in it for this reader.
  const view = (row: Row): DocsCollection | null => {
    const { slug, name, description, icon, articles, id } = row;
    if (!allowed(row)) {
      return withLocks && locks(...levelsOf(row)) && hasArticles(row) ? { slug, name, description: "", icon, articles: [], collections: [], locked: true } : null;
    }
    const collection = { slug, name, description, icon, articles: articlesFor(articles, levelsOf(row)), collections: nest(id) };
    return collection.articles.length > 0 || collection.collections.length > 0 ? collection : null;
  };
  const nest = (parentId: string): DocsCollection[] => rows.filter((row) => row.parentId === parentId).flatMap((row) => view(row) ?? []);
  const top = rows
    .filter((row) => row.parentId === null)
    .flatMap((row) => {
      const collection = view(row);
      return collection ? [{ tabId: row.tabId, collection }] : [];
    });
  // The articles in no collection are under the first tab.
  const loose = readable(reader, tabRows[0]) ? articlesFor(uncollected, [tabRows[0]]) : [];
  const tabs = tabRows.flatMap(({ id, slug, name, landing, landingArticle, landingCollection, ...level }, index): DocsTabView[] => {
    const tab = {
      slug,
      name,
      landing,
      // A deleted article's slug may be another's now.
      page: (landingArticle && !landingArticle.deletedAt ? landingArticle.slug : null) ?? landingCollection?.slug ?? null,
    };
    if (!readable(reader, level)) {
      const hasSome = rows.some((row) => row.parentId === null && row.tabId === id && hasArticles(row)) || (index === 0 && uncollected.length > 0);
      return withLocks && locks(level) && hasSome ? [{ ...tab, collections: [], uncollected: [], locked: true }] : [];
    }
    const view = { ...tab, collections: top.filter((t) => t.tabId === id).map((t) => t.collection), uncollected: index === 0 ? loose : [] };
    return view.collections.length > 0 || view.uncollected.length > 0 ? [view] : [];
  });
  return { collections: top.map((t) => t.collection), uncollected: loose, tabs, home: tabRows.at(0)?.slug ?? null, signedIn: reader?.signedIn ?? true };
});

export type DocsContents = Awaited<ReturnType<typeof docsContents>>;

export type DocsTreeCollection = {
  slug: string;
  name: string;
  icon: string | null;
  articles: DocsArticleLink[];
  collections: DocsTreeCollection[];
  open: boolean;
  locked?: true;
};

/**
 * The Docs layout's tree: tab `tab`'s collections (else the first tab with something to read, or all
 * of the docs without tabs) and its articles in none. `at` is the collection the page is, or the
 * article is in: it and the ones it's in are `open`.
 */
export function docsTree(docs: DocsContents, tab: string | null, at: string | null) {
  const { collections, uncollected } = docs.tabs.find((t) => t.slug === tab) ?? docs.tabs[0] ?? docs;
  const branch = ({ slug, name, icon, articles, collections, locked }: DocsCollection): DocsTreeCollection => {
    const inside = collections.map(branch);
    return { slug, name, icon, articles, collections: inside, open: slug === at || inside.some((c) => c.open), ...(locked && { locked }) };
  };
  return { collections: collections.map(branch), uncollected };
}

export type DocsTree = ReturnType<typeof docsTree>;

export { docsTabPath } from "@/lib/docs-level-above";

/** Every collection in `collections` and the ones in them, in reading order. */
export const everyCollection = (collections: DocsCollection[]): DocsCollection[] => collections.flatMap((c) => [c, ...everyCollection(c.collections)]);

type PublishedArticle = NonNullable<Awaited<ReturnType<typeof publishedArticle>>>;
type CollectionPage = { kind: "collection"; docs: DocsContents; tab: DocsTabView | null; parent: DocsCollection | null; collection: DocsCollection };

/**
 * What a tab's path shows this reader: its overview, or an article's or collection's page (its
 * `slug`) in its place.
 */
export type TabLanding = { kind: "overview" } | { kind: "article"; slug: string; article: PublishedArticle } | (CollectionPage & { slug: string });

/** What /docs/<slug> is for this reader. */
export type DocsPage =
  | { kind: "article"; article: PublishedArticle }
  /** An article this reader may not read, shown with a lock. */
  | { kind: "locked"; article: LockedArticle }
  | { kind: "tab"; docs: DocsContents; tab: DocsTabView; landing: TabLanding }
  | CollectionPage
  | { kind: "redirect"; path: string };

/** The first article this reader may read in `collection`'s reading order: its own, then the ones in the collections in it. */
const firstIn = (collection: DocsCollection): string | undefined =>
  collection.articles.find((a) => !a.locked)?.slug ?? collection.collections.map(firstIn).find(Boolean);

/**
 * What tab `tab`'s path shows this reader: its first article (in its first collection, else the
 * first in none), the article or collection the team picked, or its overview. A picked page this
 * reader may not read there (deleted, unpublished, hidden or AI only, restricted, locked, or in
 * another tab now) is the overview, as is a tab with no article.
 */
export async function tabLanding(projectSlug: string, docs: DocsContents, tab: DocsTabView): Promise<TabLanding> {
  const slug =
    tab.landing === "FIRST" ? (tab.collections.map(firstIn).find(Boolean) ?? tab.uncollected.find((a) => !a.locked)?.slug) : tab.landing === "PAGE" ? tab.page : null;
  if (!slug) {
    return { kind: "overview" };
  }
  const article = await publishedArticle(projectSlug, slug);
  // Its collection's tab; in none, the first tab's.
  if (article && (article.collection ? article.tab : docs.home) === tab.slug) {
    return { kind: "article", slug, article };
  }
  const found = findCollection(docs, slug);
  return found?.tab === tab && !found.collection.locked ? { kind: "collection", docs, slug, ...found } : { kind: "overview" };
}

/**
 * /docs for this reader, once per request (the page and its metadata): the first tab (or the first
 * with something to read; null without tabs) and what it shows.
 */
export const docsHome = cache(async (projectSlug: string) => {
  const docs = await docsContents(projectSlug);
  const tab = docs.tabs.find((t) => t.slug === docs.home) ?? docs.tabs[0] ?? null;
  return { docs, tab, landing: tab ? await tabLanding(projectSlug, docs, tab) : ({ kind: "overview" } as const) };
});

/**
 * A tab or collection with something this reader may read (as on /docs: a restricted or empty one is
 * as good as missing); the first tab is /docs.
 */
async function listingPage(projectSlug: string, slug: string): Promise<DocsPage | null> {
  const docs = await docsContents(projectSlug);
  if (slug === docs.home) {
    return { kind: "redirect", path: "/docs" };
  }
  const tab = docs.tabs.find((t) => t.slug === slug);
  if (tab) {
    return { kind: "tab", docs, tab, landing: await tabLanding(projectSlug, docs, tab) };
  }
  const found = findCollection(docs, slug);
  return found && { kind: "collection", docs, ...found };
}

/** Collection `slug` in `docs` (so, if this reader may read it), with its tab and the one it's in. */
export function findCollection(docs: DocsContents, slug: string) {
  const all = everyCollection(docs.collections);
  const collection = all.find((c) => c.slug === slug);
  if (!collection) {
    return null;
  }
  return {
    tab: docs.tabs.find((t) => everyCollection(t.collections).includes(collection)) ?? null,
    parent: all.find((c) => c.collections.includes(collection)) ?? null,
    collection,
  };
}

/**
 * What /docs/<slug> serves this reader, once per request (the page and its metadata): an article, a
 * tab, a collection (a slug names one of them at most), else a redirect from an old slug, else null
 * (a 404).
 */
export const docsPage = cache(async (projectSlug: string, slug: string): Promise<DocsPage | null> => {
  const found = await articleAt(projectSlug, slug);
  if (found) {
    return found.kind === "article" ? { kind: "article", article: found.article } : { kind: "locked", article: found.locked };
  }
  const listing = await listingPage(projectSlug, slug);
  if (listing) {
    return listing;
  }
  const moved = await movedPage(projectSlug, slug);
  return moved && { kind: "redirect", path: moved.path };
});

/** A published article on the portal (unless it's hidden or AI only) that this reader may read, once per request (its page and its metadata both read it). */
export const publishedArticle = cache(async (projectSlug: string, slug: string) => {
  const found = await articleAt(projectSlug, slug);
  return found?.kind === "article" ? found.article : null;
});

/**
 * A published article on the portal that this reader may not read, but that "People without
 * access" shows them with a lock: only its title, its collection and its tab, never what it says.
 */
export const lockedForReader = cache(async (projectSlug: string, slug: string) => {
  const found = await articleAt(projectSlug, slug);
  return found?.kind === "locked" ? found.locked : null;
});

export type LockedArticle = NonNullable<Awaited<ReturnType<typeof lockedForReader>>>;

/** What article `slug` is to this reader: one they may read, one locked for them, or nothing (missing, or hidden from them). */
const articleAt = cache(async (projectSlug: string, slug: string) => {
  const article = await prisma.article.findFirst({
    where: { project: { slug: projectSlug }, slug, ...servedArticle },
    select: {
      projectId: true,
      ...levelSelect,
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      showUpdatedDate: true,
      listing: true,
      description: true,
      noindex: true,
      revisedAt: true,
      collection: { select: { id: true, slug: true, name: true } },
      project: { select: { name: true } },
    },
  });
  if (!article) {
    return null;
  }
  // Its collection and the ones it's in, up to its top-level one (which has its tab); in none, the first tab.
  const up = article.collection
    ? ancestry(
        await prisma.collection.findMany({
          where: { projectId: article.projectId },
          select: { id: true, parentId: true, ...levelSelect, tab: { select: { slug: true, ...levelSelect } } },
        }),
        article.collection.id,
      )
    : [];
  const levels = [article.collection ? up.at(-1)?.tab : await firstTabLevel(article.projectId), ...up.toReversed(), article];
  const { revisedAt, collection, ...rest } = article;
  const where = {
    collection: collection && { slug: collection.slug, name: collection.name },
    /** The docs tab it's in (its collection's top-level one's), for the way back to it. */
    tab: up.at(-1)?.tab?.slug ?? null,
  };
  // For some readers only: as good as missing to everyone else, unless it's shown to them with a lock.
  const isRestricted = restricted(levels);
  const reader = isRestricted ? await currentReader(article.projectId) : null;
  if (!readable(reader, ...levels)) {
    if (!locks(...levels)) {
      return null;
    }
    // Its collection and tab only if this reader sees them listed (readable, or locked too): a hidden
    // one's name stays hidden.
    const above = levels.slice(0, -1);
    const shown = (chain: typeof levels) => readable(reader, ...chain) || locks(...chain);
    const locked = {
      collection: shown(above) ? where.collection : null,
      tab: shown(above.slice(0, 1)) ? where.tab : null,
    };
    // Picked field by field: nothing of what it says.
    return { kind: "locked" as const, locked: { slug, title: article.title, ...locked, signedIn: reader?.signedIn ?? false } };
  }
  // "Updated <date>" only once changes went live after it was published, unless the team turned it off.
  const updatedAt = article.showUpdatedDate && revisedAt && article.publishedAt && revisedAt > article.publishedAt ? revisedAt : null;
  return {
    kind: "article" as const,
    article: {
      ...rest,
      ...where,
      updatedAt,
      /** For some readers only: never kept by shared caches. */
      restricted: isRestricted,
      doc: displayDoc(article),
    },
  };
});

/**
 * Where a page that had `slug` is now (its path; `article`, its slug if it's an article), when no page
 * has `slug` any more: only if this reader may read it there, or sees it with a lock (an article, or a
 * tab or collection with something to read), so a redirect never shows that a draft, hidden or
 * restricted page is there.
 */
async function movedPage(projectSlug: string, slug: string): Promise<{ path: string; article: string | null } | null> {
  const redirect = await prisma.docsRedirect.findFirst({
    where: { slug, project: { slug: projectSlug } },
    select: { tab: { select: { slug: true } }, collection: { select: { slug: true } }, article: { select: { slug: true, deletedAt: true } } },
  });
  const article = redirect?.article;
  if (article) {
    // A deleted article's slug may be another's now.
    return !article.deletedAt && (await articleAt(projectSlug, article.slug)) ? { path: `/docs/${article.slug}`, article: article.slug } : null;
  }
  const to = redirect?.tab ?? redirect?.collection;
  const page = to && (await listingPage(projectSlug, to.slug));
  // The first tab's old slug goes to /docs.
  return page ? { path: page.kind === "redirect" ? page.path : `/docs/${to.slug}`, article: null } : null;
}

/** Where an article that had `slug` is now (its current slug), for its .md and the widget: as movedPage. */
export async function movedArticle(projectSlug: string, slug: string): Promise<string | null> {
  return (await movedPage(projectSlug, slug))?.article ?? null;
}

/** An article as Markdown, its title as the heading: /docs/<slug>.md and "Copy as Markdown" (images signed for its reader). */
export async function articleMarkdown(article: { title: string; doc: Doc }): Promise<string> {
  const title = { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: article.title }] };
  return `${toMarkdown({ type: "doc", content: [title, ...(article.doc.content ?? [])] }, { mediaUrls: await mediaUrls(article.doc) })}\n`;
}

/** How many articles the docs' home lists as popular, and over how many days their views count. */
export const POPULAR_ARTICLES = 5;
const POPULAR_DAYS = 30;

/**
 * The docs' home's "Popular articles" (Customize → Docs home): the most-viewed articles of the last
 * 30 days among those this reader sees in `docs` and may open (locked ones left out), most viewed
 * first; articles nobody viewed aren't popular.
 */
export async function popularArticles(projectSlug: string, docs: DocsContents, take = POPULAR_ARTICLES): Promise<DocsArticleLink[]> {
  const collections = (list: DocsCollection[]): DocsArticleLink[] => list.flatMap((c) => [...c.articles, ...collections(c.collections)]);
  const readable = new Map(
    [...collections(docs.collections), ...docs.uncollected].filter((article) => !article.locked).map((article) => [article.slug, article]),
  );
  if (readable.size === 0) {
    return [];
  }
  const since = new Date(Date.now() - POPULAR_DAYS * 24 * 60 * 60 * 1000);
  const top = await prisma.articleViewDay.groupBy({
    by: ["articleId"],
    where: { day: { gte: since }, article: { ...listedArticle, project: { slug: projectSlug }, slug: { in: [...readable.keys()] } } },
    _sum: { views: true },
    orderBy: [{ _sum: { views: "desc" } }, { articleId: "asc" }],
    take,
  });
  const slugs = new Map(
    (await prisma.article.findMany({ where: { id: { in: top.map((row) => row.articleId) } }, select: { id: true, slug: true } })).map((a) => [a.id, a.slug]),
  );
  return top.flatMap((row) => {
    const article = readable.get(slugs.get(row.articleId) ?? "");
    return article ? [article] : [];
  });
}
