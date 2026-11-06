import { isDeepStrictEqual } from "node:util";

import { type HtmlContent, htmlToContent, type LeftOut, type LeftOutReason } from "@tuti/content/html";
import { Prisma, prisma } from "@tuti/db";
import { articleLimit, MAX_ARTICLE_LENGTH } from "@tuti/shared";

import { recordRevision } from "./article-layers";
import { freeDocsSlug } from "./docs-slugs";
import { type Featurebase, type FeaturebaseArticle, type FeaturebaseCollection, FeaturebaseError } from "./featurebase";
import { mediaImporter } from "./import-media";
import { adminMember, ALREADY_HERE, type ImportJob, loadAdmins, type StepPage, tally } from "./imports";
import { enqueue } from "./index";
import { portalAddress } from "./portal-address";

/**
 * The help center (docs/plan.md, Switching from Featurebase, I4), in two passes so links between articles resolve
 * whatever their order: first every collection (one page: the tree needs all of them) and every article, by name
 * only, as drafts, so nothing empty is served; then each article's content, a page at a time, published as it was
 * once it lands (within the plan's article limit; one only some people could see stays a draft). The record map says
 * whether an article's content landed, so a retried or repeated import fills in what's missing.
 */

type Tx = Prisma.TransactionClient;

/** Tuti's deepest collections (apps/web lib/collection-tree.ts MAX_COLLECTION_DEPTH): deeper ones fold into the one at this level. */
const MAX_DEPTH = 5;
/** Articles per page of content: each copies its images and files, so fewer than a list's 100 fit a page's time. */
const CONTENT_PAGE = 20;
/**
 * How long a page of content converts articles (copying their media) before it saves those it has and reads the same
 * page again for the rest: import-step's time limit is 5 minutes, and a page reads Featurebase for up to 3. At least
 * one article a page, so it always gets on. Changeable for tests.
 */
export const contentBudget = { ms: 90_000 };
/** A content page's cursor that reads the list's page at the cursor after it again (none: the first). */
const AGAIN = "again:";

/** The key is checked against the help center's lists before an import starts. */
export const checkDocs = (api: Featurebase) => Promise.all([api.get("/help_center/help_centers", { limit: 1 }), api.get("/help_center/articles", { limit: 1, state: "all" })]);

export const DOCS_STEPS = [
  { name: "docs-collections", page: collectionsPage },
  { name: "docs-articles", page: articlesPage },
  { name: "docs-content", page: contentPage },
];

/** Featurebase's predefined icons (Heroicons' names) that have an obvious Lucide one; the rest are left out. */
export const FEATUREBASE_ICONS: Record<string, string> = {
  AcademicCapIcon: "graduation-cap",
  BellIcon: "bell",
  BookOpenIcon: "book-open",
  BriefcaseIcon: "briefcase",
  CalendarIcon: "calendar",
  ChartBarIcon: "chart-column",
  ChatIcon: "message-circle",
  ChatAltIcon: "message-square",
  CheckCircleIcon: "circle-check",
  ClockIcon: "clock",
  CloudIcon: "cloud",
  CodeIcon: "code",
  CogIcon: "settings",
  CreditCardIcon: "credit-card",
  CurrencyDollarIcon: "circle-dollar-sign",
  DatabaseIcon: "database",
  DocumentTextIcon: "file-text",
  FlagIcon: "flag",
  FolderIcon: "folder",
  GiftIcon: "gift",
  GlobeAltIcon: "globe",
  HeartIcon: "heart",
  HomeIcon: "house",
  InformationCircleIcon: "info",
  KeyIcon: "key",
  LightBulbIcon: "lightbulb",
  LightningBoltIcon: "zap",
  LinkIcon: "link",
  LockClosedIcon: "lock",
  MailIcon: "mail",
  PhoneIcon: "phone",
  PhotographIcon: "image",
  PlusCircleIcon: "circle-plus",
  PuzzleIcon: "puzzle",
  QuestionMarkCircleIcon: "circle-help",
  SearchIcon: "search",
  ShieldCheckIcon: "shield-check",
  SparklesIcon: "sparkles",
  StarIcon: "star",
  SupportIcon: "life-buoy",
  TagIcon: "tag",
  TerminalIcon: "terminal",
  UserIcon: "user",
  UserGroupIcon: "users",
  UsersIcon: "users",
};

/** Why an image, file or video was left out, as the summary says it ("3 images that couldn't be fetched"). */
const MEDIA_LEFT_OUT: Record<LeftOutReason, string> = {
  unsupported: "with nowhere to keep them",
  type: "of a type Tuti doesn't take",
  size: "over the size limit",
  quota: "past the project's media quota",
  unreachable: "that couldn't be fetched",
};

/** Media copies kept for each import's content step (by import), so a file in several articles is copied once. */
const mediaCaches = new Map<string, Parameters<typeof mediaImporter>[0]["cache"]>();

/** A date from Featurebase, if it's one. */
const dateOf = (value: string | null | undefined) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value) : null);
/** Featurebase's slug (`<id>-<name>`) without its id, Tuti's address for it where that's free. */
const slugOf = (slug: string | null | undefined) => slug?.replace(/^\d+-/, "").trim() ?? "";
/** Featurebase's order (null: last), as Tuti's. */
const orderOf = (order: number | null | undefined) => (Number.isFinite(order) ? Math.min(Math.max(Math.round(order!), 0), 1_000_000) : 1_000_000);

/**
 * What the project's imports from this source made of `kind` (collection, article), by Featurebase id: those whose
 * row is still there (a deleted article is there till it's purged, `deleted`), with its address.
 */
async function recorded(db: Tx, job: ImportJob, kind: "collection" | "article", externalIds?: string[]) {
  const records = await db.importedRecord.findMany({
    where: { projectId: job.projectId, source: job.source, kind, ...(externalIds && { externalId: { in: externalIds } }) },
    select: { id: true, externalId: true, localId: true, contentLanded: true },
  });
  const where = { id: { in: records.map((record) => record.localId) } };
  const rows = new Map<string, { id: string; slug: string; deleted: boolean; createdById: string | null; title?: string; saved?: boolean }>(
    kind === "collection"
      ? (await db.collection.findMany({ where, select: { id: true, slug: true } })).map((row) => [row.id, { ...row, deleted: false, createdById: null }] as const)
      : await articleRows(db, records.map((record) => record.localId)),
  );
  return new Map(records.filter((record) => rows.has(record.localId)).map((record) => [record.externalId, { record: record.id, landed: record.contentLanded, ...rows.get(record.localId)! }]));
}

/**
 * Imported articles' rows, with whether one has text or unpublished changes (`saved`). With its title, that says if the
 * team saved it since it was made empty (teamSaved).
 */
async function articleRows(db: Tx, ids: string[]) {
  const rows = await db.article.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, title: true, deletedAt: true, createdById: true } });
  const saved = await db.article.findMany({ where: { id: { in: ids }, OR: [{ content: { not: Prisma.DbNull } }, { changes: { isNot: null } }] }, select: { id: true } });
  return rows.map(({ deletedAt, ...row }) => [row.id, { ...row, deleted: deletedAt !== null, saved: saved.some((s) => s.id === row.id) }] as const);
}

/** An article's title as the import gives it. */
const titleOf = (version: { title?: string | null }) => version.title?.trim().slice(0, 120) || "Untitled";

/**
 * Whether the team saved an imported article since it was made empty: the team's now, never written over. A save gives
 * it text or unpublished changes, or a title of its own (a title-only save writes it straight to the article); the
 * import's content pass changes none of what it made but those (its collection and order stay), and restoring an
 * empty one from the trash keeps its title.
 */
const teamSaved = (local: { saved?: boolean; title?: string }, article: FeaturebaseArticle) => Boolean(local.saved) || (local.title !== undefined && local.title !== titleOf(article));

/** Saves what `kind` records became here; one whose row was deleted since is replaced. */
async function remember(tx: Tx, job: ImportJob, kind: "collection" | "article", made: { externalId: string; localId: string }[]) {
  const where = { projectId: job.projectId, source: job.source, kind };
  await tx.importedRecord.deleteMany({ where: { ...where, externalId: { in: made.map((record) => record.externalId) } } });
  await tx.importedRecord.createMany({ data: made.map((record) => ({ ...where, ...record })) });
}

/**
 * Collections, all in one page (a child may come before its parent): each in its parent, up to Tuti's five levels;
 * deeper ones aren't made, and what's in them goes into their fifth-level ancestor. Top-level ones go into the docs'
 * first tab (as tabFor does), each after what's there, siblings in Featurebase's order.
 */
async function collectionsPage(job: ImportJob): Promise<StepPage> {
  let page = await job.featurebase.page<FeaturebaseCollection>("/help_center/collections", null);
  const all = [...page.items];
  while (page.next) {
    page = await job.featurebase.page<FeaturebaseCollection>("/help_center/collections", page.next);
    all.push(...page.items);
  }
  const byId = new Map(all.map((collection) => [collection.id, collection]));
  // Each one and the ones it's in, up to the top (a parent Featurebase didn't list, or a loop, ends it).
  const chains = all.map((collection) => {
    const chain = [collection];
    for (let up = byId.get(collection.parentId ?? ""); up && !chain.includes(up); up = byId.get(up.parentId ?? "")) {
      chain.push(up);
    }
    return chain;
  });
  // Parents first; siblings in their order.
  chains.sort((a, b) => a.length - b.length || orderOf(a[0]!.order) - orderOf(b[0]!.order) || (a[0]!.name ?? "").localeCompare(b[0]!.name ?? ""));

  return {
    next: null,
    save: async (tx) => {
      const known = await recorded(tx, job, "collection");
      const firstTab = await tx.docsTab.findFirst({ where: { projectId: job.projectId }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true } });
      const local = new Map([...known].map(([id, row]) => [id, row.id]));
      const made: { externalId: string; localId: string }[] = [];
      const nextOrder = new Map<string | null, number>();
      for (const chain of chains) {
        const collection = chain[0]!;
        if (chain.length > MAX_DEPTH) {
          tally(job.counts, "collections", "more than five levels deep (what was in them is in the fifth level)");
          const into = local.get(chain[chain.length - MAX_DEPTH]!.id);
          if (into && !known.has(collection.id)) {
            made.push({ externalId: collection.id, localId: into });
            local.set(collection.id, into);
          }
          continue;
        }
        if (known.has(collection.id)) {
          tally(job.counts, "collections", ALREADY_HERE);
          continue;
        }
        tally(job.counts, "collections", null);
        const parentId = (chain[1] && local.get(chain[1].id)) ?? null;
        const tabId = parentId === null ? (firstTab?.id ?? null) : null;
        if (!nextOrder.has(parentId)) {
          const last = await tx.collection.aggregate({ where: { projectId: job.projectId, parentId, ...(parentId === null && { tabId }) }, _max: { order: true } });
          nextOrder.set(parentId, (last._max.order ?? -1) + 1);
        }
        const order = nextOrder.get(parentId)!;
        nextOrder.set(parentId, order + 1);
        const name = collection.name?.trim().slice(0, 60) || "Untitled";
        const icon = collection.icon?.type === "predefined" ? FEATUREBASE_ICONS[collection.icon.value] : undefined;
        const { id } = await tx.collection.create({
          data: {
            projectId: job.projectId,
            parentId,
            tabId,
            slug: await freeDocsSlug(tx, job.projectId, slugOf(collection.slug) || name, "collection"),
            name,
            description: collection.description?.trim().slice(0, 300) ?? "",
            icon: icon ?? null,
            order,
            createdAt: dateOf(collection.createdAt) ?? new Date(),
          },
          select: { id: true },
        });
        made.push({ externalId: collection.id, localId: id });
        local.set(collection.id, id);
      }
      await remember(tx, job, "collection", made);
    },
  };
}

/**
 * Makes articles not made yet, empty, as drafts, in their collection (folded ones' in the fifth level's), by their
 * author (a team member or a placeholder: adminMember), with their description and date; their address is
 * Featurebase's where that's free, else from their title.
 */
async function makeArticles(tx: Tx, job: ImportJob, articles: FeaturebaseArticle[]) {
  const known = await recorded(tx, job, "article", articles.map((article) => article.id));
  const fresh = [...new Map(articles.filter((article) => !known.has(article.id)).map((article) => [article.id, article])).values()];
  if (fresh.length === 0) {
    return;
  }
  const collections = await recorded(tx, job, "collection", fresh.flatMap((article) => (article.parentId ? [article.parentId] : [])));
  const made: { externalId: string; localId: string }[] = [];
  for (const article of fresh) {
    const title = titleOf(article);
    const author = article.author?.authorId ? await adminMember(tx, job, article.author.authorId, { name: article.author.name }) : null;
    const { id } = await tx.article.create({
      data: {
        projectId: job.projectId,
        title,
        slug: await freeDocsSlug(tx, job.projectId, slugOf(article.slug) || title, "article"),
        description: article.description?.trim().slice(0, 300) ?? "",
        collectionId: collections.get(article.parentId ?? "")?.id ?? null,
        order: orderOf(article.order),
        createdById: author?.userId ?? null,
        createdAt: dateOf(article.createdAt) ?? new Date(),
      },
      select: { id: true },
    });
    made.push({ externalId: article.id, localId: id });
  }
  await remember(tx, job, "article", made);
}

/** Pass 1's articles: every one (drafts too), made empty, a page at a time. */
async function articlesPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const { items, next } = await job.featurebase.page<FeaturebaseArticle>("/help_center/articles", cursor, { state: "all" });
  await loadAdmins(job);
  return { next, save: (tx) => makeArticles(tx, job, items) };
}

/**
 * Where links to Featurebase's articles and collections go now: a path like /en/articles/1234567-setup (or
 * /articles/…, /en/help/articles/…, /collections/…), on any host, whose id came across, to that page on the portal.
 */
async function linksTo(job: ImportJob, portal: string, html: string[]): Promise<(href: string) => string | null> {
  // Only the ids the HTML mentions (a superset of what its links match below), not every page the import made.
  const ids = (kind: string) => [...html.join("\n").matchAll(new RegExp(`/${kind}/(\\d+)`, "g"))].map((match) => match[1]!);
  const [articles, collections] = await Promise.all([recorded(prisma, job, "article", ids("articles")), recorded(prisma, job, "collection", ids("collections"))]);
  return (href) => {
    let path: string;
    try {
      path = new URL(href, "https://featurebase.invalid").pathname;
    } catch {
      return null;
    }
    const [, kind, id] = /^\/(?:[A-Za-z-]+\/)?(?:help\/)?(articles|collections)\/(\d+)(?:-|\/|$)/.exec(path) ?? [];
    const page = id ? (kind === "articles" ? articles : collections).get(id) : undefined;
    return page && !page.deleted ? `${portal}/docs/${page.slug}` : null;
  };
}

/** Its unpublished draft, for one Featurebase says has changes; null when there's none after all. */
async function draftOf(job: ImportJob, article: FeaturebaseArticle): Promise<FeaturebaseArticle | null> {
  if (!article.isPublished || !article.isDraftDiffersFromLive) {
    return null;
  }
  return job.featurebase.get<FeaturebaseArticle>(`/help_center/articles/${encodeURIComponent(article.id)}`, { state: "draft" }).catch((error: unknown) => {
    if (error instanceof FeaturebaseError && error.status === 404) {
      return null;
    }
    throw error;
  });
}

type Text = { title: string; content: HtmlContent };

/**
 * Pass 2: a page of articles' content (those whose content hasn't landed), their media copied and links pointed at
 * their new pages first, outside the lock. Each is published as it was in Featurebase (dated when it was last
 * updated there), within the plan's article limit; one only some people could see, or past the limit, stays a draft.
 * One published with a draft that differs keeps the draft as its unpublished changes (a draft here takes the draft's
 * text: the newest). Published ones are indexed for search once the page is saved.
 */
async function contentPage(job: ImportJob, cursor: string | null): Promise<StepPage> {
  const started = Date.now();
  // A page read again counts only what it converts: it counted the rest the first time.
  const again = cursor?.startsWith(AGAIN) ?? false;
  const listCursor = again ? cursor!.slice(AGAIN.length) || null : cursor;
  const { items, next: listNext } = await job.featurebase.page<FeaturebaseArticle>("/help_center/articles", listCursor, { state: "all", limit: CONTENT_PAGE });
  await loadAdmins(job);
  const known = await recorded(prisma, job, "article", items.map((article) => article.id));
  const todo = items.filter((article) => {
    const local = known.get(article.id);
    return !local || (!local.landed && !local.deleted && !teamSaved(local, article));
  });
  const portal = todo.length > 0 ? await portalAddress((await prisma.project.findUniqueOrThrow({ where: { id: job.projectId }, select: { slug: true } })).slug) : "";
  // Those of imports that ended without their last page (failed, or failed as stale) go.
  const running = await prisma.dataImport.findMany({ where: { id: { in: [...mediaCaches.keys()] }, state: "RUNNING" }, select: { id: true } });
  [...mediaCaches.keys()].filter((id) => !running.some((row) => row.id === id)).forEach((id) => mediaCaches.delete(id));
  const cache = mediaCaches.get(job.id) ?? new Map();
  mediaCaches.set(job.id, cache);
  // Copies are the import's starter's uploads (someone who left since: none copied).
  const media = job.startedById ? mediaImporter({ projectId: job.projectId, uploaderId: job.startedById, cache }) : undefined;
  // `draftLost`: why its unpublished changes didn't come (the published version did), said in the summary.
  const texts: { article: FeaturebaseArticle; live: Text | { error: string }; draft: Text | null; draftLost: string | null }[] = [];
  for (const article of todo) {
    if (texts.length > 0 && Date.now() - started > contentBudget.ms) {
      break;
    }
    // Its draft is read first, while the page is within its time (contentBudget): converting copies media, which
    // Featurebase's read deadline (import-step's PAGE_READ_MS) doesn't wait for.
    const draftVersion = await draftOf(job, article);
    const link = await linksTo(job, portal, [article.body ?? "", draftVersion?.body ?? ""]);
    // `error`: why it's left out, as the summary says it (the article stays an empty draft).
    const convert = async (version: FeaturebaseArticle): Promise<Text | { error: string }> => {
      const content = await htmlToContent("article", version.body ?? "", { media, link });
      if ("error" in content) {
        return { error: "whose content couldn't be read" };
      }
      // Past what an article may have (its saves are refused): none of it, rather than part.
      if (content.text.length > MAX_ARTICLE_LENGTH) {
        return { error: `longer than ${MAX_ARTICLE_LENGTH.toLocaleString("en")} characters, Tuti's most` };
      }
      return { title: titleOf(version), content };
    };
    const live = await convert(article);
    const draft = draftVersion && !("error" in live) ? await convert(draftVersion) : null;
    const differs = draft && !("error" in draft) && !("error" in live) && !isDeepStrictEqual([draft.title, draft.content.doc], [live.title, live.content.doc]);
    texts.push({ article, live, draft: differs ? (draft as Text) : null, draftLost: draft && "error" in draft ? draft.error : null });
  }
  const next = texts.length < todo.length ? `${AGAIN}${listCursor ?? ""}` : listNext;
  if (!next) {
    mediaCaches.delete(job.id);
  }

  let published: string[] = [];
  return {
    next,
    save: async (tx) => {
      published = [];
      await makeArticles(tx, job, items);
      const locals = await recorded(tx, job, "article", items.map((article) => article.id));
      const { plan } = await tx.project.findUniqueOrThrow({ where: { id: job.projectId }, select: { plan: true } });
      const limit = articleLimit(plan);
      let room = limit === null ? Infinity : limit - (await tx.article.count({ where: { projectId: job.projectId, publishedAt: { not: null }, deletedAt: null } }));
      for (const article of items) {
        const local = locals.get(article.id);
        const text = texts.find((t) => t.article === article);
        // Not converted for want of time: the page read again does it.
        if (!text && todo.includes(article)) {
          continue;
        }
        // Deleted here before its content landed: left deleted and not landed, so if it's restored, a later import fills it in.
        if (local?.deleted && !local.landed) {
          if (!again) {
            tally(job.counts, "articles", "deleted here since");
          }
          continue;
        }
        // Landed before (or by a run of this page that got in first), deleted here since it landed, or saved by the team
        // since it was made empty (an import that stopped between its passes, started again): as it is.
        if (!local || local.landed || local.deleted || teamSaved(local, article) || !text) {
          if (local && !local.landed) {
            await tx.importedRecord.update({ where: { id: local.record }, data: { contentLanded: true } });
          }
          if (!again) {
            tally(job.counts, "articles", ALREADY_HERE);
          }
          continue;
        }
        await tx.importedRecord.update({ where: { id: local.record }, data: { contentLanded: true } });
        if ("error" in text.live) {
          tally(job.counts, "articles", `${text.live.error} (they're empty drafts)`);
          continue;
        }
        const everyone = isDeepStrictEqual(article.visibleBy ?? ["everyone"], ["everyone"]);
        const wasPublished = article.isPublished ?? article.state === "live";
        const publish = wasPublished && everyone && room > 0;
        tally(job.counts, wasPublished && !everyone ? "privateDrafts" : wasPublished && !publish ? "limitDrafts" : "articles", null);
        if (text.draftLost) {
          tally(job.counts, "unpublishedChanges", `${text.draftLost} (the published version came in)`);
        }
        if (publish) {
          room--;
          published.push(local.id);
        }
        const { title, content } = publish ? text.live : (text.draft ?? text.live);
        const changes = publish ? text.draft : null;
        const leftOut = new Map<string, LeftOut>([...content.leftOut, ...(changes?.content.leftOut ?? [])].map((item) => [item.url, item]));
        leftOut.forEach((item) => tally(job.counts, `${item.kind}s`, MEDIA_LEFT_OUT[item.reason]));
        const at = dateOf(article.updatedAt) ?? dateOf(article.createdAt) ?? new Date();
        const saved = await tx.article.update({
          where: { id: local.id },
          data: { title, content: content.doc, body: content.text, publishedAt: publish ? at : null, updatedAt: at },
          select: { collectionId: true },
        });
        await recordRevision(tx, local.id, local.createdById, undefined, at);
        if (changes) {
          await tx.articleChanges.create({ data: { articleId: local.id, title: changes.title, content: changes.content.doc, body: changes.content.text, collectionId: saved.collectionId } });
          await recordRevision(tx, local.id, local.createdById);
        }
      }
    },
    // As publishing does (indexArticle): never twice, as only a page's saved run gets here, and only for what it filled.
    after: async () => {
      for (const articleId of published) {
        await enqueue("articleChanged", { articleId }).catch(() => {});
      }
    },
  };
}
