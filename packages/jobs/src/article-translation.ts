import { type Doc, fromPlainText, keyed, sections, segmentsOf, toPlainText, translateDoc } from "@tuti/content";
import { Prisma, prisma } from "@tuti/db";
import { aiEnabled, complete, contentHash, isLanguage, type JobInput, LANGUAGES, log as serverLog } from "@tuti/shared";

import { aiFor } from "./ai-usage";
import { OutOfCredits } from "./credits";
import { freeLanguageSlug } from "./docs-slugs";
import { behindKey, behindSections, docOfSections, metaOf, ownedByTeam, type Section, type SectionMeta, sourceSections, versionSections, withTranslation } from "./translation-sections";
import { lockProject } from "./running-draft";
import { embedTranslation } from "./articles";
import { enqueue, type JobLogger, type JobResult, type JobRun } from "./index";

/**
 * Article translations (docs/plan.md, Languages, L6): a published article into each of the project's languages kept up
 * to date (`article_translation.automatic`), by the `translation` AI role, charged like any other. The model only ever
 * sees segments (@tuti/content translateDoc), and only those whose text changed since the last translation.
 */

/** Why a manual version's sections are behind after "Our product is available in" changed. */
export const PRODUCT_SETTING_CHANGED = "The product's language setting changed.";


/** Why a translation waits, as Settings → Languages shows it. */
export const TRANSLATION_WAITS = {
  credits: "Out of credits",
  provider: "The translation provider didn't answer",
  checks: "The translation failed its checks",
  error: "Couldn't translate it",
} as const;

/** The first retry on its own comes this long after a failure, then twice as long each time, up to a day. */
const RETRY_FIRST_MS = 15 * 60_000;
const RETRY_MAX_MS = 24 * 60 * 60_000;
const STALE = "the product's language setting changed";
const CHANGED = "changed while translating";
const NO_AI = "AI isn't set up";
/**
 * A queued translation not ended by then is taken as lost, and queued again. On Hatchet longer than the task may wait in
 * the queue (its `scheduleTimeout`, 24 hours, behind the server-wide cap) plus run (`executionTimeout`, 10 minutes), so
 * one still queued is never queued twice; inline nothing waits in a queue, so an hour brings back what a restart cut off.
 */
export const lostAfterMs = () => (process.env.JOBS_DRIVER === "inline" ? 60 : 25 * 60) * 60_000;
export const retryDelay = (tries: number) => Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, tries - 1), RETRY_MAX_MS);

const ABOUT = "an article from a software product's help center: its title, meta description and search keywords (the first paragraphs), then its text";

const sourceSelect = {
  projectId: true,
  title: true,
  description: true,
  keywords: true,
  body: true,
  content: true,
  publishedAt: true,
  sample: true,
  slug: true,
  project: { select: { language: true } },
} as const;
type Source = Prisma.ArticleGetPayload<{ select: typeof sourceSelect }>;

const paragraph = (text: string) => ({ type: "paragraph", ...(text && { content: [{ type: "text", text }] }) });

/**
 * What a published article's translation is made from, as one document (so one call translates it, the title giving its
 * text context): its title, description and keywords as the first paragraphs, then its text; and its hash.
 */
export function translationSource(article: Pick<Source, "title" | "description" | "keywords" | "body" | "content">) {
  const text = (article.content as Doc | null) ?? fromPlainText(article.body);
  const meta = [article.title, article.description, ...article.keywords].map(paragraph);
  const doc: Doc = { type: "doc", content: [...meta, ...(text.content ?? [])] };
  return { doc, text, meta: meta.length, hash: contentHash(JSON.stringify(["translation", article.title, article.description, article.keywords, text])) };
}

/**
 * The instructions sent with every request: "Our product is available in" first (off: the product's interface labels
 * stay as written; on: they're translated, as the glossary sets them where it has them; a glossary entry wins either
 * way), then the team's own.
 */
export function translationInstructions(language: string, productAvailable: boolean, instructions: string) {
  const product = productAvailable
    ? `The product is available in ${language}: translate the names of its buttons, screens, menus and settings with the rest, using the glossary's words for them where it has them.`
    : `The product isn't available in ${language}: keep the names of its buttons, screens, menus and settings exactly as written in the source (readers see them that way), unless the glossary gives a translation.`;
  return [product, instructions.trim()].filter(Boolean).join("\n\n");
}

const languageName = (code: string) => (isLanguage(code) ? LANGUAGES[code].name : code);

/**
 * Translates an article into one language, or says why it waits (`error`, tried again on its own with backoff). Writes
 * only while the source is the one it translated and "Our product is available in" is the setting it started under
 * (checked in the update itself): else it writes nothing and ends, as the change's own job covers the page.
 */
export async function translateArticle(input: JobInput<"translateArticle">, log: JobLogger, run: JobRun = { lastTry: true }): Promise<JobResult> {
  // Its guarded write, once it has read the row: a failure is recorded only on the generation this job started from.
  const started: Started = {};
  try {
    const result = await translateOne(input, log, run, started);
    if (result.skipped && result.skipped !== STALE && result.skipped !== CHANGED && result.skipped !== NO_AI && started.retryAt) {
      // Nothing left to do for it: the safety net's try goes, unless a newer publish or Retranslate set another since it read it.
      // Without AI it stays, so the retry job translates the page once AI is set up.
      await prisma.articleTranslation.updateMany({ where: { articleId: input.articleId, language: input.language, retryAt: started.retryAt }, data: { retryAt: null } });
    }
    return result;
  } catch (error) {
    if (!run.lastTry) {
      throw error;
    }
    log.warn(`Translating article ${input.articleId} into ${input.language} failed: ${String(error).slice(0, 300)}`);
    // Through the same guards as a translation's write (the source, the setting's version, Retranslate's count), so an older
    // job never marks a newer translation as failed. Failing before it read the row, it writes nothing: the page's safety
    // net brings it back.
    await started
      .settle?.({ error: TRANSLATION_WAITS.error, tries: { increment: 1 }, retryAt: new Date(Date.now() + RETRY_MAX_MS) })
      .catch((error: unknown) => serverLog.error("Saving an article translation's failure failed", { ...input, error }));
    return { failed: "error" };
  }
}

type Data = Prisma.ArticleTranslationUpdateManyMutationInput;
/** The version as it is when the job writes (its row locked): the write is made from it, so a save of the team's isn't lost. */
type Locked = Prisma.ArticleTranslationGetPayload<{ select: typeof lockedSelect }>;
/**
 * `data`, or what to write made from the version as it is then (null: nothing). `newVersion`: the write is a new text, whose
 * old search sections go with it (search by meaning never answers with them).
 */
type Settle = (data: Data | ((now: Locked) => Data | null), newVersion?: boolean) => Promise<boolean>;
const lockedSelect = { automatic: true, title: true, titleSource: true, content: true, sections: true, removedSections: true, draft: true, behind: true, updateSections: true, publishedAt: true } as const;

/** A version's draft as stored (ArticleTranslation.draft). */
export type Draft = { title: string; titleEdited: boolean; content: Doc; sections: SectionMeta[]; /** Source sections the team took out of it. */ removed?: string[] };

/** A version's text (published or its draft) for working out what's behind: on a version the team writes, every section is theirs and one the source has that it doesn't is behind too, but those it took out. */
export type BehindList = { list: Section[]; teamWrites: boolean; removed?: Iterable<string> };

/**
 * Why each section is behind (`behind`): the team's sections whose source section changed since they were translated or
 * edited, in the published text or the draft ("English changed since this was edited."); `kept`, other reasons kept.
 */
export function behindOf(sourceLanguage: string, source: ReturnType<typeof sourceSections>, lists: BehindList[], kept: Record<string, string> = {}) {
  const [changed, added] = [sourceChanged(sourceLanguage), sourceAdded(sourceLanguage)];
  const out: Record<string, string> = { ...kept };
  for (const { list, teamWrites, removed } of lists) {
    const own = teamWrites ? ownedByTeam(list) : list;
    for (const key of behindSections(own, source)) out[key] = changed;
    if (teamWrites) {
      const has = new Set(list.map(({ meta }) => meta.key));
      for (const key of behindSections(own, source, { missing: true, removed: new Set(removed) })) if (!has.has(key)) out[key] ??= added;
    }
  }
  return out;
}

/** Why a section is behind when the source has it and a version the team writes doesn't (added, or renamed). */
export const sourceAdded = (sourceLanguage: string) => `${languageName(sourceLanguage)} has this section, and this version doesn't yet.`;

/** Why a section is behind when its source section changed since the team's edit. */
export const sourceChanged = (sourceLanguage: string) => `${languageName(sourceLanguage)} changed in this section since it was edited.`;

/** `behind`'s reasons besides the source changing (the product setting's, the glossary's): kept as they are by a write that works that one out again. */
export const otherReasons = (behind: unknown, sourceLanguage: string) =>
  Object.fromEntries(Object.entries((behind ?? {}) as Record<string, string>).filter(([, why]) => why !== sourceChanged(sourceLanguage) && why !== sourceAdded(sourceLanguage)));
/** What a job learns as it goes: its guarded write once it has one, and the safety net's time it read. */
type Started = { settle?: Settle; retryAt?: Date | null };

async function translateOne({ articleId, language }: JobInput<"translateArticle">, log: JobLogger, { lastTry }: JobRun, started: Started): Promise<JobResult> {
  const row = await prisma.articleTranslation.findUnique({
    where: { articleId_language: { articleId, language } },
    select: {
      id: true,
      automatic: true,
      publishedAt: true,
      sourceHash: true,
      productAvailable: true,
      memory: true,
      error: true,
      retryAt: true,
      tries: true,
      slug: true,
      retranslate: true,
      retranslated: true,
      updateSections: true,
      projectLanguage: { select: { productAvailable: true, productVersion: true, instructions: true } },
      article: { select: sourceSelect },
    },
  });
  started.retryAt = row?.retryAt;
  // A version the team writes is translated only where it asked (Update those sections).
  const asked = (row?.updateSections ?? []) as string[];
  if (!row || (!row.automatic && asked.length === 0)) {
    return { skipped: "not kept up to date" };
  }
  const { article, projectLanguage: setting } = row;
  if (!article.publishedAt || article.sample) {
    return { skipped: "not published" };
  }
  const source = translationSource(article);
  const sameSetting = row.productAvailable === setting.productAvailable;
  // A Retranslate not answered yet: nothing reused.
  const fresh = row.retranslate !== row.retranslated;
  if (!fresh && asked.length === 0 && row.publishedAt && !row.error && row.sourceHash === source.hash && sameSetting) {
    if (!row.slug) {
      // Translated, but its naming failed then: named now.
      await nameVersion(article.projectId, row.id);
    }
    // Its search data too: one whose embedding failed is embedded here when the retry job brings it back (none to do: a lookup).
    return (await searchable(row.id, row.tries, row.retryAt, log)) ? { skipped: "up to date" } : { failed: SEARCH_WAITS };
  }
  // Turned off on the server: nothing to ask, and nothing a Try again would change.
  if (!aiEnabled()) {
    return { skipped: NO_AI };
  }
  const version = setting.productVersion;

  /**
   * Writes `data` only while the article's published source is still `source` (locked, so a publish can't slip in
   * between), and the language's product setting is still `version` and no Retranslate was asked for since it read the
   * row (both in the update's own WHERE). False: it changed, and the job that change queued writes instead.
   */
  const settle: Settle = (data, newVersion = false) =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM article WHERE id = ${articleId} FOR UPDATE`;
      const now = await tx.article.findUnique({ where: { id: articleId }, select: sourceSelect });
      if (!now?.publishedAt || translationSource(now).hash !== source.hash) {
        return false;
      }
      // The version too, as the team's own writes lock it (articles.saveTranslation, …), after the article.
      await tx.$queryRaw`SELECT 1 FROM article_translation WHERE id = ${row.id} FOR UPDATE`;
      const locked = await tx.articleTranslation.findUnique({ where: { id: row.id }, select: lockedSelect });
      const written = locked && (typeof data === "function" ? data(locked) : data);
      if (!written) {
        return false;
      }
      const { count } = await tx.articleTranslation.updateMany({ where: { id: row.id, retranslate: row.retranslate, projectLanguage: { productVersion: version } }, data: written });
      if (count > 0 && newVersion && "content" in written) {
        // The old text's search sections go in the same transaction: until the new one's are embedded (searchable, next),
        // search by meaning finds nothing of it, never the old text under the new title (its words still find it).
        await tx.articleTranslationChunk.deleteMany({ where: { translationId: row.id } });
      }
      return count > 0;
    });
  started.settle = settle;
  const waits = async (why: string) => {
    const tries = row.tries + 1;
    await settle({ error: why.slice(0, 500), tries, retryAt: new Date(Date.now() + retryDelay(tries)) });
    return { failed: why };
  };

  let ai;
  try {
    ai = await aiFor(article.projectId, "translation");
  } catch (error) {
    if (error instanceof OutOfCredits) {
      return waits(TRANSLATION_WAITS.credits);
    }
    throw error;
  }
  // The setting is checked before each request too, so a job it made stale stops early instead of paying for the rest.
  let stale = false;
  const ask = async (system: string, user: string) => {
    const now = await prisma.projectLanguage.findUnique({ where: { projectId_code: { projectId: article.projectId, code: language } }, select: { productVersion: true } });
    if (now?.productVersion !== version) {
      stale = true;
      throw new Error("The product's language setting changed");
    }
    return complete({ system, user, timeoutMs: 60_000, ...ai });
  };
  // Remembered translations only from the same setting: one made under the other treats the product's words the other way.
  const memory = !fresh && sameSetting ? (row.memory as Record<string, string>) : {};
  const parts = sourceSections(source.text);
  // A version the team writes is translated only where it asked: just those sections are sent (no title, description or
  // keywords, which are the team's), and only their problems count.
  const askedParts = row.automatic ? null : parts.filter((part) => asked.includes(part.key));
  // The source's segments as they are now: what a version the team writes may remember.
  const current = new Set(askedParts ? segmentsOf(source.doc).segments.map((segment) => segment.text) : []);
  const toTranslate: Doc = askedParts ? { type: "doc", content: askedParts.flatMap((part) => part.blocks) } : source.doc;
  const result = await translateDoc(toTranslate, {
    from: languageName(article.project.language),
    to: languageName(language),
    instructions: translationInstructions(languageName(language), setting.productAvailable, setting.instructions),
    about: ABOUT,
    ask,
    memory,
  });
  if (stale) {
    return { skipped: STALE };
  }
  if (result.providerError && !lastTry) {
    // Hatchet tries again; the last try keeps the reason, and the page is tried again later on its own.
    throw new Error(`The translation provider didn't answer: ${result.providerError}`);
  }
  if (result.providerError) {
    return waits(TRANSLATION_WAITS.provider);
  }
  if (result.problems.length > 0) {
    // Never a page with some sections left in the source language: it waits, the source's version shown meanwhile.
    log.warn(`Translating article ${articleId} into ${language}: ${result.problems.map((p) => p.reason).join("; ").slice(0, 300)}`);
    return waits(`${TRANSLATION_WAITS.checks}: ${result.problems[0]!.reason}`);
  }
  const blocks = result.doc.content ?? [];
  const text = (i: number) => toPlainText(blocks[i]!).trim();
  // Lined up with the source's sections: the asked ones translated, the rest as they are (never used: only the asked are taken).
  const asTranslated = askedParts && new Map(askedParts.map((part, i) => [part.key, sections(blocks)[i] ?? part.blocks]));
  const translated: Doc = asTranslated ? { type: "doc", content: parts.flatMap((part) => asTranslated.get(part.key) ?? part.blocks) } : { type: "doc", content: blocks.slice(source.meta) };
  // Retranslating and unpublished changes (docs/plan.md, Languages): the published text and the draft take the new
  // translation in every section the team doesn't own; a version kept up to date in all of them, one the team writes in
  // those it asked for. Sections it asked for are no longer its own.
  // Asked for meanwhile (after this read): left for the next run, which this one queues.
  let more = false;
  const titleHash = contentHash(article.title);
  const written = await settle((now) => {
    // Kept up to date or not as when this read it (what was translated depends on it): else the next run writes.
    if (now.automatic !== row.automatic) {
      return null;
    }
    // Only what's still asked for as it writes: one another run did meanwhile, or the team chose since to keep (publishing with
    // `keep`) or edited again (saving), is no longer overridden.
    const still = new Set(asked.filter((key) => (now.updateSections as string[]).includes(key)));
    const only = now.automatic ? undefined : still;
    // The sections asked for take the new translation, whoever owns them (an edit made since included): that's what was asked.
    const published = withTranslation(versionSections(now.content as Doc | null, now.sections, parts), translated, parts, { only, asked: still, published: now.automatic, removed: new Set(now.removedSections as string[]) });
    const draft = now.draft as Draft | null;
    const drafted = draft && withTranslation(versionSections(draft.content, draft.sections, parts), translated, parts, { only, asked: still, removed: new Set(draft.removed) });
    const waiting = (now.updateSections as string[]).filter((key) => !asked.includes(key));
    more = waiting.length > 0;
    // The team's published title stays theirs until the source's title changes.
    const ownTitle = now.titleSource === titleHash;
    const content = docOfSections(published);
    // A version the team writes that it never published: only its draft is written (nothing of it goes live by itself).
    const draftOnly = !now.automatic && !now.publishedAt;
    // A version the team writes keeps its other reasons (the product setting's, the glossary's) but where it was updated.
    const kept = now.automatic ? {} : Object.fromEntries(Object.entries(now.behind as Record<string, string>).filter(([key]) => !still.has(key)));
    return {
      ...(now.automatic && {
        ...(!ownTitle && { title: text(0), titleSource: null }),
        description: text(1),
        keywords: article.keywords.map((_, i) => text(2 + i)),
        sourceHash: source.hash,
      }),
      ...(!draftOnly && { content: content as Prisma.InputJsonValue, body: toPlainText(content), sections: metaOf(published) as Prisma.InputJsonValue }),
      ...(draft &&
        drafted && {
          // Its title the team's while it's edited there, or while the published one is theirs.
          draft: { ...draft, title: draft.titleEdited || ownTitle || !now.automatic ? draft.title : text(0), content: docOfSections(drafted), sections: metaOf(drafted) } as Prisma.InputJsonValue,
        }),
      behind: behindOf(
        article.project.language,
        parts,
        [
          ...(draftOnly ? [] : [{ list: published, teamWrites: !now.automatic, removed: now.removedSections as string[] }]),
          ...(drafted ? [{ list: drafted, teamWrites: !now.automatic, removed: draft.removed }] : []),
        ],
        kept,
      ),
      updateSections: waiting,
      ...(!draftOnly && { publishedAt: now.publishedAt ?? new Date() }),
      productAvailable: setting.productAvailable,
      // Only the sections asked for were sent: what's remembered of the others stays, but only what this run could use (made
      // under the same setting, not after a Retranslate) and only for the source's text as it is now.
      memory: askedParts ? Object.fromEntries(Object.entries({ ...memory, ...result.memory }).filter(([text]) => current.has(text))) : result.memory,
      error: null,
      tries: 0,
      retryAt: null,
      retranslated: row.retranslate,
    };
  }, true);
  if (written) {
    // Named first (its own transaction, the project locked), then searchable (docs/plan.md L7): a failure there never undoes
    // the translation, it's embedded later. Its retry time as this run left it: the write just cleared it.
    await nameVersion(article.projectId, row.id).catch((error: unknown) => log.warn(`Naming article ${articleId}'s ${language} version failed: ${String(error).slice(0, 300)}`));
    await searchable(row.id, 0, null, log);
    if (more) await queueVersion(articleId, language);
  }
  return written ? { translated: language } : { skipped: CHANGED };
}

/**
 * A version the team published (articles.publishTranslation), after its own transaction: named, on its first publish, and
 * its new text made searchable (a failure is retried by the retry job, as the job's is). Never throws.
 */
export async function versionPublished(projectId: string, versionId: string, first: boolean) {
  const log = { info: () => {}, warn: (message: string) => serverLog.warn(message) };
  if (first) {
    await nameVersion(projectId, versionId).catch((error: unknown) => serverLog.error("Naming an article's version failed", { versionId, error }));
  }
  const { tries, retryAt } = (await prisma.articleTranslation.findUnique({ where: { id: versionId }, select: { tries: true, retryAt: true } })) ?? { tries: 0, retryAt: null };
  await searchable(versionId, tries, retryAt, log).catch((error: unknown) => serverLog.error("Embedding an article's version failed", { versionId, error }));
}

/** Why a version up to date is tried again: its sections couldn't be embedded for search. */
const SEARCH_WAITS = "its search data couldn't be written";

/**
 * Embeds a written version's sections for search in its language (embedTranslation). Failing (the embeddings provider
 * didn't answer), its retry time is set, backing off as a translation's does (`tries`, the failures in a row so far):
 * the retry job brings it back here, where, up to date, it's only embedded; embedded, the count starts again. The version
 * itself is shown as written meanwhile, its error left alone.
 */
async function searchable(translationId: string, tries: number, read: Date | null, log: JobLogger) {
  try {
    await embedTranslation(translationId, log);
    if (tries > 0) {
      await prisma.articleTranslation.updateMany({ where: { id: translationId, error: null }, data: { tries: 0 } });
    }
    return true;
  } catch (error) {
    log.warn(`Embedding translation ${translationId} for search failed: ${String(error).slice(0, 300)}`);
    // The backoff replaces the time this run read (its own safety net, the retry job's claim); a newer queuing's, set
    // meanwhile, is kept where it's earlier, so a late failure never pushes it back.
    const next = new Date(Date.now() + retryDelay(tries + 1));
    await prisma.$executeRaw`
      UPDATE article_translation SET tries = ${tries + 1}, "updatedAt" = now(),
        "retryAt" = CASE WHEN "retryAt" IS NOT DISTINCT FROM ${read}::timestamp(3) THEN ${next}::timestamp(3) ELSE LEAST(COALESCE("retryAt", ${next}::timestamp(3)), ${next}::timestamp(3)) END
      WHERE id = ${translationId}`;
    return false;
  }
}

/** Queues a translate job, never failing the caller: the page waits, and the retry job or Try again picks it up. */
async function queue(articleId: string, language: string) {
  try {
    await enqueue("translateArticle", { articleId, language });
  } catch (error) {
    serverLog.error("Queuing an article's translation failed", { articleId, language, error });
    // It waits like a failed translation, so the retry job queues it again (and Try again counts it).
    await prisma.articleTranslation
      .updateMany({ where: { articleId, language }, data: { error: TRANSLATION_WAITS.error, retryAt: new Date(Date.now() + retryDelay(1)) } })
      .catch((error: unknown) => serverLog.error("Saving an article translation's failure failed", { articleId, language, error }));
  }
}

/**
 * Pages this process will still queue (inline the jobs run one by one here, so a long batch passes its pages' hour): the
 * retry job leaves them to the batch, so none is translated, and paid for, twice. A restart empties it.
 */
// How many batches hold each page: one finishing leaves it marked while another still holds it.
const onTheirWay = new Map<string, number>();
const pageKey = (articleId: string, language: string) => `${articleId}:${language}`;
/** At most this many pages per retry run (the oldest due first); the next run takes the rest. Tests lower it. */
export const retryBatch = { size: 500 };

/** Queues pages one after another, each counted as on its way until its turn has been queued. */
async function queueEach(pages: { articleId: string; language: string }[]) {
  const held = pages.map(({ articleId, language }) => pageKey(articleId, language));
  const release = (key: string) => {
    const count = (onTheirWay.get(key) ?? 1) - 1;
    if (count > 0) onTheirWay.set(key, count);
    else onTheirWay.delete(key);
  };
  held.forEach((key) => onTheirWay.set(key, (onTheirWay.get(key) ?? 0) + 1));
  try {
    for (const { articleId, language } of pages) {
      await queue(articleId, language);
      release(held.shift()!);
    }
  } finally {
    held.forEach(release);
  }
}

/**
 * A safety net, set on every page about to be queued before the first is: a job lost, or never queued (a restart partway
 * through, inline; Hatchet dropping it), is queued again by the retry job once it's past, as the job's every end sets or
 * clears it.
 */
// Moved on each queuing (not set only when empty), so a job that finds its page up to date can tell a newer queuing's net
// from the one it read; a page waiting on a failure keeps its backoff.
const safetyNet = (where: Prisma.ArticleTranslationWhereInput) =>
  prisma.articleTranslation.updateMany({ where: { ...where, error: null }, data: { retryAt: new Date(Date.now() + lostAfterMs()) } });

/** Queuing (inline, translating) still going after the request or publish answered. */
const inBackground = new Set<Promise<void>>();
/** Runs `queuing`: inline, where each job runs as it's queued, in the background, so a save or request never waits on the model. */
function queueAll(queuing: () => Promise<void>) {
  // Never awaited: a language's every page queued (or, inline, translated) one by one would hold the request for long. Each
  // page already has its safety net, so one a restart keeps this from reaching is queued again by the retry job.
  const running = queuing().catch((error: unknown) => serverLog.error("Queuing article translations failed", { error }));
  inBackground.add(running);
  void running.finally(() => inBackground.delete(running));
}
/** Resolves once everything queued in the background is queued (inline: translated). For tests. */
export async function languageTranslationsDone() {
  // Those queued meanwhile too (a job's translating that changed the setting).
  while (inBackground.size > 0) {
    await Promise.all([...inBackground]);
  }
}

/**
 * Published articles that are translated: sample content never is (as it's never embedded), nor a deleted one (which the
 * article_deleted_unpublished check already keeps unpublished; said here too).
 */
const translatable = { publishedAt: { not: null }, deletedAt: null, sample: false } as const;

/** Versions the translate job writes: those kept up to date, and others where the team asked for sections (Update those sections). */
const translatedByJob = { OR: [{ automatic: true }, { NOT: { updateSections: { equals: [] } } }] } satisfies Prisma.ArticleTranslationWhereInput;

/**
 * An article was published or its published text changed (the article-changed job): translates it into each language
 * keeping it up to date, starting a version in each language that's Automatic for new pages.
 */
export async function queueArticleTranslations(articleId: string) {
  const article = await prisma.article.findFirst({
    where: { id: articleId, ...translatable },
    select: { projectId: true, translations: { select: { language: true, automatic: true } }, project: { select: { languages: { select: { code: true, automatic: true } } } } },
  });
  if (!article) {
    return;
  }
  const missing = article.project.languages.filter(({ code, automatic }) => automatic && !article.translations.some((t) => t.language === code));
  await prisma.articleTranslation.createMany({ data: missing.map(({ code }) => ({ articleId, projectId: article.projectId, language: code })), skipDuplicates: true });
  const languages = [...article.translations.filter((t) => t.automatic).map((t) => t.language), ...missing.map(({ code }) => code)];
  await safetyNet({ articleId, language: { in: languages } });
  queueAll(() => queueEach(languages.map((language) => ({ articleId, language }))));
}

/**
 * One version translated in the background (Update those sections, or a published draft's sections that need the new
 * translation): its safety net first, then queued, as a language's pages are.
 */
export async function queueVersion(articleId: string, language: string) {
  await safetyNet({ articleId, language });
  queueAll(() => queueEach([{ articleId, language }]));
}

/**
 * Queues a language's versions kept up to date (adding the language, Retranslate, the product setting changing), those
 * waiting for a first translation too; with Automatic for new pages, every published article gets a version first.
 * `fresh`: nothing reused (Retranslate). `waiting`: only those that couldn't be translated (Try again). How many it queued.
 */
export async function queueLanguageTranslations(projectId: string, language: string, { fresh = false, waiting = false } = {}): Promise<number> {
  const setting = await prisma.projectLanguage.findUnique({ where: { projectId_code: { projectId, code: language } }, select: { automatic: true } });
  if (!setting) {
    return 0;
  }
  if (setting.automatic) {
    const articles = await prisma.article.findMany({ where: { projectId, ...translatable, translations: { none: { language } } }, select: { id: true } });
    await prisma.articleTranslation.createMany({ data: articles.map(({ id }) => ({ articleId: id, projectId, language })), skipDuplicates: true });
  }
  const rows = await prisma.articleTranslation.findMany({
    // Waiting: those that failed (or couldn't be queued), not those queued and not translated yet, which would be paid twice.
    where: { projectId, language, automatic: true, article: translatable, ...(waiting && { error: { not: null } }) },
    select: { id: true, articleId: true },
  });
  await safetyNet({ id: { in: rows.map(({ id }) => id) } });
  if (fresh) {
    // On the row, so the retries of one that fails send everything too.
    await prisma.articleTranslation.updateMany({ where: { id: { in: rows.map(({ id }) => id) } }, data: { retranslate: { increment: 1 } } });
  }
  queueAll(() => queueEach(rows.map(({ articleId }) => ({ articleId, language }))));
  return rows.length;
}

/**
 * "Our product is available in" changed: in the versions the team writes every section is marked behind. Run in the
 * transaction that saves the change (languages.update), so the change is saved only with them marked.
 */
export async function markProductSettingBehind(tx: Prisma.TransactionClient, projectId: string, language: string) {
  const manual = await tx.articleTranslation.findMany({
    where: { projectId, language, automatic: false, article: { deletedAt: null } },
    select: { id: true, article: { select: { title: true, description: true, keywords: true, body: true, content: true } } },
  });
  // A few statements however many there are, so a large help center stays well inside the transaction's time.
  const marked = manual.map(({ id, article }) => Prisma.sql`(${id}, ${JSON.stringify(Object.fromEntries(keyed(translationSource(article).text).map(([key]) => [behindKey(key), PRODUCT_SETTING_CHANGED])))})`);
  for (let i = 0; i < marked.length; i += 500) {
    await tx.$executeRaw`
      UPDATE article_translation t SET behind = v.behind::jsonb, "updatedAt" = now()
      FROM (VALUES ${Prisma.join(marked.slice(i, i + 500))}) AS v(id, behind) WHERE t.id = v.id`;
  }
}

/** The retry-article-translations job: versions that couldn't be translated, whose wait is over, tried again. */
export async function retryArticleTranslations(): Promise<JobResult> {
  // Sections asked for with no time to try again (a job the previous release's worker skipped during a deploy, as it doesn't
  // know them): due now, so this run queues them.
  await prisma.articleTranslation.updateMany({ where: { retryAt: null, NOT: { updateSections: { equals: [] } }, article: translatable }, data: { retryAt: new Date() } });
  // Naming needs no AI: versions translated before they had slugs get theirs whatever the server's set up with.
  const named = await nameUnnamed();
  // Without AI nothing can translate them: their times stay, so they're taken once AI is set up.
  if (!aiEnabled()) {
    return { skipped: NO_AI, ...(named > 0 && { named }) };
  }
  // Pages a batch here will still queue (its own runs' too) are left to it; the rest is claimed in one update, so a run
  // that overlaps a slow one takes none of its pages. The claim is the safety net's next time, so pages a restart keeps
  // this run from reaching come back too.
  const now = new Date();
  // Read a page at a time past those held here, so a big batch's pages never crowd out everything else's.
  const ready: { id: string; articleId: string; language: string }[] = [];
  // Paged by the (retryAt, id) read, not a cursor row: a held page's job moving its time can't shift where reading resumes.
  for (let after: { retryAt: Date; id: string } | undefined; ready.length < retryBatch.size; ) {
    const page = await prisma.articleTranslation.findMany({
      where: {
        retryAt: { lte: now },
        AND: [translatedByJob, ...(after ? [{ OR: [{ retryAt: { gt: after.retryAt } }, { retryAt: after.retryAt, id: { gt: after.id } }] }] : [])],
      },
      orderBy: [{ retryAt: "asc" }, { id: "asc" }],
      take: retryBatch.size,
      select: { id: true, articleId: true, language: true, retryAt: true },
    });
    ready.push(...page.filter(({ articleId, language }) => !onTheirWay.has(pageKey(articleId, language))).slice(0, retryBatch.size - ready.length));
    if (page.length < retryBatch.size) break;
    const last = page.at(-1)!;
    after = { retryAt: last.retryAt!, id: last.id };
  }
  const due = await prisma.articleTranslation.updateManyAndReturn({
    where: { id: { in: ready.map(({ id }) => id) }, retryAt: { lte: now }, ...translatedByJob },
    data: { retryAt: new Date(Date.now() + lostAfterMs()) },
    select: { articleId: true, language: true },
  });
  // Each job's end sets the next try's time, or clears it.
  await queueEach(due);
  return { queued: due.length, ...(named > 0 && { named }) };
}

/**
 * A version's first translation names it: a slug in its language from its title (freeLanguageSlug); later ones keep the
 * address (a rename is the team's: articles.languageSlug). Its own transaction, after the translation's: slugs are picked
 * with the project locked, and that lock is never taken while holding the article's (whose other writers, search's
 * sections, wait on the project's row by its foreign key). Left unnamed if this fails: the page's next job names it.
 */
export async function nameVersion(projectId: string, versionId: string) {
  await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const version = await tx.articleTranslation.findUnique({
      where: { id: versionId },
      select: { slug: true, title: true, language: true, articleId: true, publishedAt: true, article: { select: { slug: true, deletedAt: true } } },
    });
    // Only once it's published: an address is for reading it.
    if (!version || version.slug || version.article.deletedAt || !version.publishedAt) {
      return;
    }
    const slug = await freeLanguageSlug(tx, projectId, version.language, version.title, { id: versionId, articleId: version.articleId, slug: null }, version.article.slug);
    await tx.articleTranslation.update({ where: { id: versionId }, data: { slug } });
  });
}

/** Unnamed versions named per run of the retry job. */
/** Unnamed versions named per run of the retry job (a test can change it). */
export const nameBatch = { size: 200 };

/**
 * Versions translated before versions had slugs of their own (L6 part one) have none: named a batch per run of the retry job
 * (meanwhile, served at the article's default-language slug), those waiting longest first. One that fails goes to the back
 * (its time moved on), so a few that always fail never take every run's batch. How many it named.
 * ponytail: a scan for unnamed versions every run; a partial index on them is the upgrade if the table grows large.
 */
async function nameUnnamed(): Promise<number> {
  const unnamed = await prisma.articleTranslation.findMany({
    where: { slug: null, publishedAt: { not: null }, article: { deletedAt: null } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: nameBatch.size,
    select: { id: true, projectId: true },
  });
  let named = 0;
  for (const { id, projectId } of unnamed) {
    try {
      await nameVersion(projectId, id);
      named++;
    } catch (error) {
      serverLog.error("Naming an article's version failed", { versionId: id, error });
      await prisma.articleTranslation.updateMany({ where: { id }, data: { updatedAt: new Date() } }).catch(() => {});
    }
  }
  return named;
}
