import { createHash } from "node:crypto";

import { type Segment, segmentOfText, translateSegments } from "@tuti/content";
import { Prisma, prisma } from "@tuti/db";
import { aiEnabled, complete, type JobInput, log as serverLog } from "@tuti/shared";

import { aiFor } from "./ai-usage";
import { languageName, lostAfterMs, queueAll, retryDelay, translationInstructions } from "./article-translation";
import { OutOfCredits } from "./credits";
import { enqueue, type JobLogger, type JobResult } from "./index";

/**
 * Labels' translations (docs/plan.md, Languages, L13): a docs collection's name and description and a tab's name in each of
 * the project's languages, in a `translations` column on each: `{ de: { name, description, auto, source } }`. Automatic
 * ones (`auto`) are made by the `translate-labels` job and kept up to date; the team's own stay as they wrote them.
 */
export type LabelTranslation = {
  name: string;
  description?: string;
  /** Kept up to date by the job (else the team wrote it). */
  auto: boolean;
  /** labelSource of the name and description it was made from (null: to be made again, Retranslate). */
  source: string | null;
};
export type LabelTranslations = Record<string, LabelTranslation>;

/**
 * A label's text as one hash: an md5 of its name and description, so the database works it out the same way
 * (STALE_COLLECTIONS, STALE_TABS) and the retry job finds labels to translate whatever wrote them (imports, Autopilot).
 */
export const labelSource = (name: string, description = "") => createHash("md5").update(`${name}\u001f${description}`).digest("hex");

/**
 * A label in `language`: its translation there while it's current (the team's, or one kept up to date made from the name and
 * description as they are, never an old one), else null (readers see the default language's).
 */
export function labelIn(label: { name: string; description?: string; translations: unknown }, language: string | null | undefined): { name: string; description: string } | null {
  const translation = language ? (label.translations as LabelTranslations | null)?.[language] : undefined;
  if (!translation || (translation.auto && translation.source !== labelSource(label.name, label.description))) {
    return null;
  }
  return { name: translation.name, description: translation.description ?? "" };
}

const ABOUT = "the names and descriptions of a software product's help center sections (short labels, each one on its own)";

/** Labels to translate in a language (SQL, for `language` and whether it's Automatic for new pages): new ones, and automatic ones whose text changed. */
const stale = (source: Prisma.Sql, language: string, automatic: Prisma.Sql) => Prisma.sql`(
  (translations -> ${language} IS NULL AND ${automatic})
  OR ((translations -> ${language} ->> 'auto')::boolean AND (translations -> ${language} ->> 'source') IS DISTINCT FROM md5(${source}))
)`;
const COLLECTION_SOURCE = Prisma.sql`name || chr(31) || description`;
const TAB_SOURCE = Prisma.sql`name || chr(31)`;

type Label = { table: "collection" | "tab"; id: string; name: string; description: string };

/** A project's labels to translate into `language` (sample collections never are, as sample articles aren't). */
async function labelsToTranslate(projectId: string, language: string, automatic: boolean): Promise<Label[]> {
  const auto = automatic ? Prisma.sql`true` : Prisma.sql`false`;
  const [collections, tabs] = await Promise.all([
    prisma.$queryRaw<{ id: string; name: string; description: string }[]>`
      SELECT id, name, description FROM collection
      WHERE "projectId" = ${projectId} AND NOT sample AND ${stale(COLLECTION_SOURCE, language, auto)} ORDER BY "createdAt", id`,
    prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM docs_tab WHERE "projectId" = ${projectId} AND ${stale(TAB_SOURCE, language, auto)} ORDER BY "order", id`,
  ]);
  return [...collections.map((row) => ({ table: "collection" as const, ...row })), ...tabs.map((row) => ({ table: "tab" as const, ...row, description: "" }))];
}

/**
 * Translates a project's labels into one language: new ones (where it's Automatic for new pages) and those kept up to date
 * whose name or description changed. Each is written only while its text is still the one translated and the language's
 * "Our product is available in" is the setting it started under; a label whose translation failed its checks waits, the
 * rest are written. Failing (no credits, the provider), it's tried again by the retry job, backing off.
 */
export async function translateLabels({ projectId, language }: JobInput<"translateLabels">, log: JobLogger): Promise<JobResult> {
  if (!aiEnabled()) {
    return { skipped: "AI isn't set up" };
  }
  const setting = await prisma.projectLanguage.findUnique({
    where: { projectId_code: { projectId, code: language } },
    select: { automatic: true, productAvailable: true, productVersion: true, labelsVersion: true, createdAt: true, instructions: true, labelsTries: true, project: { select: { language: true } } },
  });
  if (!setting) {
    return { skipped: "not a language of the project" };
  }
  const labels = await labelsToTranslate(projectId, language, setting.automatic);
  const settled = (data: { labelsTries: number; labelsRetryAt: Date | null }) => prisma.projectLanguage.updateMany({ where: { projectId, code: language }, data });
  if (labels.length === 0) {
    await settled({ labelsTries: 0, labelsRetryAt: null });
    return { skipped: "up to date" };
  }
  const waits = async (why: string) => {
    const tries = setting.labelsTries + 1;
    await settled({ labelsTries: tries, labelsRetryAt: new Date(Date.now() + retryDelay(tries)) });
    return { failed: why };
  };
  let ai;
  try {
    ai = await aiFor(projectId, "translation");
  } catch (error) {
    if (error instanceof OutOfCredits) {
      return waits("Out of credits");
    }
    throw error;
  }
  // One segment per name and description, `<label>.n` and `<label>.d`: plain text, as an Inbox message's.
  const parts = labels.flatMap((label, i) =>
    [
      ["n", label.name],
      ["d", label.description],
    ]
      .filter(([, text]) => text)
      .map(([part, text]) => ({ id: `${i}.${part}`, ...segmentOfText(text!) })),
  );
  const segments: Segment[] = parts.map(({ id, segment }) => ({ id, text: segment.text }));
  const byId = new Map(parts.map((part) => [part.id, part]));
  let stale = false;
  const result = await translateSegments(
    segments,
    {
      from: languageName(setting.project.language),
      to: languageName(language),
      instructions: translationInstructions(languageName(language), setting.productAvailable, setting.instructions),
      about: ABOUT,
      ask: async (system, user) => {
        if (!(await sameSetting(prisma, projectId, language, setting))) {
          stale = true;
          throw new Error("The product's language setting changed, or Retranslate was asked for");
        }
        return complete({ system, user, timeoutMs: 60_000, ...ai });
      },
    },
    (id, text) => byId.get(id)!.check("1", text),
  );
  if (stale) {
    // Its own change queued the labels again.
    return { skipped: "the product's language setting changed, or Retranslate was asked for" };
  }
  const translated = (id: string) => {
    const text = result.translations[id];
    const out = text === undefined ? undefined : byId.get(id)!.apply(text);
    return typeof out === "string" ? out : undefined;
  };
  // Written, and not translated (failed its checks, or the provider didn't answer). One that changed meanwhile is neither:
  // its change queued it again.
  let [written, failed] = [0, 0];
  for (const [i, label] of labels.entries()) {
    const name = translated(`${i}.n`);
    const description = label.description ? translated(`${i}.d`) : "";
    if (name === undefined || description === undefined) {
      failed++;
      continue;
    }
    const entry: LabelTranslation = { name, ...(label.table === "collection" && { description }), auto: true, source: labelSource(label.name, label.description) };
    written += await writeLabel(label, projectId, language, setting, entry);
  }
  if (failed > 0) {
    log.warn(`Translating project ${projectId}'s labels into ${language}: ${failed} of ${labels.length} waiting (${(result.providerError ?? result.problems[0]?.reason ?? "").slice(0, 200)})`);
    return { translated: written, ...(await waits(result.providerError ? "The translation provider didn't answer" : "The translation failed its checks")) };
  }
  await settled({ labelsTries: 0, labelsRetryAt: null });
  return { translated: written };
}

type Versions = { productVersion: number; labelsVersion: number; createdAt: Date };

/**
 * Whether the language's product setting is still the one a job started under, no Retranslate was asked for since, and
 * it's the same language (removed and added again, its counters start again: `createdAt` tells them apart).
 */
async function sameSetting(db: Prisma.TransactionClient | typeof prisma, projectId: string, language: string, started: Versions) {
  const now = await db.projectLanguage.findUnique({ where: { projectId_code: { projectId, code: language } }, select: { productVersion: true, labelsVersion: true, createdAt: true } });
  return now?.productVersion === started.productVersion && now.labelsVersion === started.labelsVersion && now.createdAt.getTime() === started.createdAt.getTime();
}

/**
 * One label's translation, written under its row's lock only while it still has the text translated, it's still new or
 * kept up to date there (the team's own is never replaced), and the language's product setting and Retranslates are the
 * ones it started under (sameSetting).
 */
async function writeLabel(label: Label, projectId: string, language: string, started: Versions, entry: LabelTranslation): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // The language's row first (as its changes lock it: removing it, its product setting, Retranslate), shared: a change
    // under way is waited for, and one after waits for this write (and then clears or remakes it).
    await tx.$queryRaw`SELECT 1 FROM project_language WHERE "projectId" = ${projectId} AND code = ${language} FOR SHARE`;
    const rows =
      label.table === "collection"
        ? await tx.$queryRaw<{ name: string; description: string; translations: LabelTranslations }[]>`SELECT name, description, translations FROM collection WHERE id = ${label.id} FOR UPDATE`
        : await tx.$queryRaw<{ name: string; description: string; translations: LabelTranslations }[]>`SELECT name, '' AS description, translations FROM docs_tab WHERE id = ${label.id} FOR UPDATE`;
    const now = rows[0];
    const current = now?.translations[language];
    if (!now || labelSource(now.name, now.description) !== entry.source || (current && !current.auto) || !(await sameSetting(tx, projectId, language, started))) {
      return 0;
    }
    const translations = { ...now.translations, [language]: entry } as Prisma.InputJsonValue;
    await (label.table === "collection"
      ? tx.collection.update({ where: { id: label.id }, data: { translations } })
      : tx.docsTab.update({ where: { id: label.id }, data: { translations } }));
    return 1;
  });
}

/**
 * Queues a project's labels' translating into each of its languages (or `languages`), in the background (never awaited, as
 * an article's languages are: inline, the save would wait for the model), never failing the caller: the retry job finds
 * what's left. Tests wait for it with languageTranslationsDone.
 */
export async function queueLabels(projectId: string, languages?: string[]) {
  if (!aiEnabled()) return;
  queueAll(async () => {
    const codes = languages ?? (await prisma.projectLanguage.findMany({ where: { projectId }, select: { code: true } })).map(({ code }) => code);
    for (const language of codes) {
      await queueOne(projectId, language);
    }
  });
}

/**
 * The project languages whose labels are being queued here (inline: translated), each with whether it was asked for again
 * meanwhile. Hatchet runs one at a time per project and language (its concurrency key); inline, this does: one asked for
 * while another runs goes once it ends, so quick saves never translate (and pay for) the same labels twice at once.
 * ponytail: one process's; several processes on the inline driver can still overlap (Hatchet is for that).
 */
const labelRuns = new Map<string, { again: boolean }>();

async function queueOne(projectId: string, language: string) {
  const key = `${projectId}:${language}`;
  const running = labelRuns.get(key);
  if (running) {
    running.again = true;
    return;
  }
  const run = { again: false };
  labelRuns.set(key, run);
  try {
    do {
      run.again = false;
      await enqueue("translateLabels", { projectId, language }).catch(async (error: unknown) => {
        serverLog.error("Queuing a project's label translations failed", { projectId, language, error });
        // Tried again at the retry job's next run but one (as an article's queuing is), not after a claim's safety net.
        await prisma.$executeRaw`UPDATE project_language SET "labelsRetryAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${retryDelay(1) / 1000})
          WHERE "projectId" = ${projectId} AND code = ${language}`.catch((marking: unknown) => serverLog.error("Saving a label translating's failure failed", { projectId, language, error: marking }));
      });
    } while (run.again);
  } finally {
    labelRuns.delete(key);
  }
}

/**
 * Retranslate, or "Our product is available in" changing: the labels kept up to date in a language are made again (their
 * `source` cleared, so they're found stale; read meanwhile, readers see the default language's), and a labels job already
 * running writes nothing (`labelsVersion`). Run in the change's transaction.
 */
export async function retranslateLabels(tx: Prisma.TransactionClient | typeof prisma, projectId: string, language: string) {
  await tx.projectLanguage.updateMany({ where: { projectId, code: language }, data: { labelsVersion: { increment: 1 } } });
  for (const table of [Prisma.raw("collection"), Prisma.raw("docs_tab")]) {
    await tx.$executeRaw`
      UPDATE ${table} SET translations = jsonb_set(translations, ${[language, "source"]}::text[], 'null'::jsonb)
      WHERE "projectId" = ${projectId} AND (translations -> ${language} ->> 'auto')::boolean`;
  }
}

/** Languages removed from a project: their label translations go with them (as their articles' versions do), so adding one again translates its labels anew. */
export async function forgetLabels(tx: Prisma.TransactionClient, projectId: string, languages: string[]) {
  if (languages.length === 0) return;
  for (const table of [Prisma.raw("collection"), Prisma.raw("docs_tab")]) {
    await tx.$executeRaw`UPDATE ${table} SET translations = translations - ${languages}::text[] WHERE "projectId" = ${projectId} AND translations ?| ${languages}::text[]`;
  }
}

/**
 * The retry job's part (every 15 minutes): each project language with labels to translate whose wait (if any) is over gets
 * its job, whatever wrote the labels (imports, Autopilot, a job lost in a restart). How many it queued.
 */
export async function queueStaleLabels(): Promise<number> {
  // Claimed in one update, its time moved to the safety net's (as articles' retries are): a run overlapping this one, or the
  // next while its job is still on its way, doesn't queue it again; a job lost in a restart is found once that time comes.
  // The job's end clears it, or sets the next try's.
  const due = await prisma.$queryRaw<{ projectId: string; code: string }[]>`
    UPDATE project_language l SET "labelsRetryAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${lostAfterMs() / 1000})
    WHERE (l."labelsRetryAt" IS NULL OR l."labelsRetryAt" <= now() AT TIME ZONE 'UTC')
      AND (
        EXISTS (SELECT 1 FROM collection c WHERE c."projectId" = l."projectId" AND NOT c.sample AND ${staleIn(COLLECTION_SOURCE)})
        OR EXISTS (SELECT 1 FROM docs_tab t WHERE t."projectId" = l."projectId" AND ${staleIn(TAB_SOURCE)})
      )
    RETURNING l."projectId", l.code`;
  for (const { projectId, code } of due) {
    await queueLabels(projectId, [code]);
  }
  return due.length;
}

/** `stale` with the project language's own code and setting (a column, in queueStaleLabels's query). */
const staleIn = (source: Prisma.Sql) => Prisma.sql`(
  (translations -> l.code IS NULL AND l.automatic)
  OR ((translations -> l.code ->> 'auto')::boolean AND (translations -> l.code ->> 'source') IS DISTINCT FROM md5(${source}))
)`;
