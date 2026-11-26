import { type Doc, fromPlainText, keyed, toPlainText, translateDoc } from "@tuti/content";
import { type Prisma, prisma } from "@tuti/db";
import { aiEnabled, complete, contentHash, isLanguage, type JobInput, LANGUAGES, log as serverLog } from "@tuti/shared";

import { aiFor } from "./ai-usage";
import { OutOfCredits } from "./credits";
import { enqueue, type JobLogger, type JobResult, type JobRun } from "./index";

/**
 * Article translations (docs/plan.md, Languages, L6): a published article into each of the project's languages kept up
 * to date (`article_translation.automatic`), by the `translation` AI role, charged like any other. The model only ever
 * sees segments (@tuti/content translateDoc), and only those whose text changed since the last translation.
 */

/** Why a manual version's sections are behind after "Our product is available in" changed. */
export const PRODUCT_SETTING_CHANGED = "The product's language setting changed.";

/** A section's key (@tuti/content keyed) as `behind` stores it: Postgres's JSON can't hold its NUL, so a unit separator. */
export const behindKey = (key: string) => key.replace("\u0000", "\u001f");

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
  try {
    return await translateOne(input, log, run);
  } catch (error) {
    if (!run.lastTry) {
      throw error;
    }
    log.warn(`Translating article ${input.articleId} into ${input.language} failed: ${String(error).slice(0, 300)}`);
    await prisma.articleTranslation
      .updateMany({ where: { articleId: input.articleId, language: input.language }, data: { error: TRANSLATION_WAITS.error, tries: { increment: 1 }, retryAt: new Date(Date.now() + RETRY_MAX_MS) } })
      .catch((error: unknown) => serverLog.error("Saving an article translation's failure failed", { ...input, error }));
    return { failed: "error" };
  }
}

async function translateOne({ articleId, language, fresh = false }: JobInput<"translateArticle">, log: JobLogger, { lastTry }: JobRun): Promise<JobResult> {
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
      tries: true,
      projectLanguage: { select: { productAvailable: true, productVersion: true, instructions: true } },
      article: { select: sourceSelect },
    },
  });
  if (!row?.automatic) {
    return { skipped: "not kept up to date" };
  }
  const { article, projectLanguage: setting } = row;
  if (!article.publishedAt || article.sample) {
    return { skipped: "not published" };
  }
  const source = translationSource(article);
  const sameSetting = row.productAvailable === setting.productAvailable;
  if (!fresh && row.publishedAt && !row.error && row.sourceHash === source.hash && sameSetting) {
    return { skipped: "up to date" };
  }
  // Turned off on the server: nothing to ask, and nothing a Try again would change.
  if (!aiEnabled()) {
    return { skipped: "AI isn't set up" };
  }
  const version = setting.productVersion;

  /**
   * Writes `data` only while the article's published source is still `source` (locked, so a publish can't slip in
   * between) and the language's product setting is still `version` (in the update's own WHERE). False: it changed, and
   * the job that change queued writes instead.
   */
  const settle = (data: Prisma.ArticleTranslationUpdateManyMutationInput) =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM article WHERE id = ${articleId} FOR UPDATE`;
      const now = await tx.article.findUnique({ where: { id: articleId }, select: sourceSelect });
      if (!now?.publishedAt || translationSource(now).hash !== source.hash) {
        return false;
      }
      const { count } = await tx.articleTranslation.updateMany({ where: { id: row.id, automatic: true, projectLanguage: { productVersion: version } }, data });
      return count > 0;
    });
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
  const result = await translateDoc(source.doc, {
    from: languageName(article.project.language),
    to: languageName(language),
    instructions: translationInstructions(languageName(language), setting.productAvailable, setting.instructions),
    about: ABOUT,
    ask,
    memory,
  });
  if (stale) {
    return { skipped: "the product's language setting changed" };
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
  const content: Doc = { type: "doc", content: blocks.slice(source.meta) };
  const written = await settle({
    title: text(0),
    description: text(1),
    keywords: article.keywords.map((_, i) => text(2 + i)),
    content: content as Prisma.InputJsonValue,
    body: toPlainText(content),
    publishedAt: row.publishedAt ?? new Date(),
    sourceHash: source.hash,
    productAvailable: setting.productAvailable,
    memory: result.memory,
    behind: {},
    error: null,
    tries: 0,
    retryAt: null,
  });
  return written ? { translated: language } : { skipped: "changed while translating" };
}

/** Queues a translate job, never failing the caller: the page waits, and the retry job or Try again picks it up. */
async function queue(articleId: string, language: string, fresh?: boolean) {
  try {
    await enqueue("translateArticle", { articleId, language, ...(fresh && { fresh }) });
  } catch (error) {
    serverLog.error("Queuing an article's translation failed", { articleId, language, error });
    // It waits like a failed translation, so the retry job queues it again (and Try again counts it).
    await prisma.articleTranslation
      .updateMany({ where: { articleId, language }, data: { error: TRANSLATION_WAITS.error, retryAt: new Date(Date.now() + retryDelay(1)) } })
      .catch((error: unknown) => serverLog.error("Saving an article translation's failure failed", { articleId, language, error }));
  }
}

/** Queuing a whole language run inline (JOBS_DRIVER=inline: no Hatchet), still going after the request answered. */
const inBackground = new Set<Promise<void>>();
/** Resolves once every whole language queued inline is translated (tests). */
export async function languageTranslationsDone() {
  // Those queued meanwhile too (a job's translating that changed the setting).
  while (inBackground.size > 0) {
    await Promise.all([...inBackground]);
  }
}

/** Published articles that are translated: sample content never is (as it's never embedded). */
const translatable = { publishedAt: { not: null }, sample: false } as const;

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
  for (const language of [...article.translations.filter((t) => t.automatic).map((t) => t.language), ...missing.map(({ code }) => code)]) {
    await queue(articleId, language);
  }
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
    select: { articleId: true },
  });
  const queuing = (async () => {
    for (const { articleId } of rows) {
      await queue(articleId, language, fresh);
    }
  })();
  // Inline, each job runs as it's queued: a language's every page would hold the request for minutes.
  if (process.env.JOBS_DRIVER === "inline") {
    inBackground.add(queuing);
    void queuing.finally(() => inBackground.delete(queuing));
  } else {
    await queuing;
  }
  return rows.length;
}

/**
 * "Our product is available in" changed (after languages.update counted it in `productVersion`): versions kept up to
 * date are retranslated (jobs already running write nothing), and in the others every section is marked behind.
 */
export async function productSettingChanged(projectId: string, language: string) {
  const manual = await prisma.articleTranslation.findMany({
    where: { projectId, language, automatic: false, article: { deletedAt: null } },
    select: { id: true, article: { select: { title: true, description: true, keywords: true, body: true, content: true } } },
  });
  for (const { id, article } of manual) {
    const behind = Object.fromEntries(keyed(translationSource(article).text).map(([key]) => [behindKey(key), PRODUCT_SETTING_CHANGED]));
    await prisma.articleTranslation.update({ where: { id }, data: { behind } });
  }
  return queueLanguageTranslations(projectId, language);
}

/** The retry-article-translations job: versions that couldn't be translated, whose wait is over, tried again. */
export async function retryArticleTranslations(): Promise<JobResult> {
  const due = await prisma.articleTranslation.findMany({
    where: { retryAt: { lte: new Date() }, automatic: true },
    orderBy: { retryAt: "asc" },
    take: 500,
    select: { id: true, articleId: true, language: true },
  });
  for (const { id, articleId, language } of due) {
    // Cleared first: a failure, or the queuing failing, sets the next try's time again.
    await prisma.articleTranslation.update({ where: { id }, data: { retryAt: null } });
    await queue(articleId, language);
  }
  return { queued: due.length };
}
