import { Prisma, prisma } from "@tuti/db";
import { type LabelTranslation, type LabelTranslations, labelSource, queueLabels } from "@tuti/jobs";
import { aiEnabled, collectionName, LANGUAGE_CODES, LANGUAGES } from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/**
 * Labels' translations (docs/plan.md, Languages, L13 and L14): a docs collection's name and description, a tab's name, and a
 * board's name and description, in each of the project's languages, as their settings' Translations show them. Kept up to date (made by the translate-labels job,
 * made again when its text changes) or the team's own (never replaced).
 */

/** What differs between a collection's, a tab's and a board's: its table, its noun, and whether it has a description. */
type Kind = { table: "collection" | "docs_tab" | "board"; noun: "collection" | "tab" | "board"; description: boolean };
const COLLECTION: Kind = { table: "collection", noun: "collection", description: true };
const TAB: Kind = { table: "docs_tab", noun: "tab", description: false };
const BOARD: Kind = { table: "board", noun: "board", description: true };

const language = z.enum(LANGUAGE_CODES).describe("The language's code (one of the project's languages)").meta({ examples: ["de"] });
const keepUpToDateOutput = z.boolean().describe("Made and kept up to date by AI (else the team's own, never replaced)").meta({ examples: [true] });
const nameOutput = z.string().nullable().describe("Its name there: the translation readers see (null: none yet, readers see the default language's)");

const collectionTranslation = z
  .object({
    language: z.string().describe("The language's code").meta({ examples: ["de"] }),
    name: nameOutput.meta({ examples: ["Erste Schritte"] }),
    description: z.string().nullable().describe("Its description there (null as for name)").meta({ examples: ["Die Grundlagen in fünf Minuten."] }),
    keepUpToDate: keepUpToDateOutput,
  })
  .describe("A collection's name and description in one of the project's languages");
const tabTranslation = z
  .object({
    language: z.string().describe("The language's code").meta({ examples: ["de"] }),
    name: nameOutput.meta({ examples: ["Anleitungen"] }),
    keepUpToDate: keepUpToDateOutput,
  })
  .describe("A tab's name in one of the project's languages");
const boardTranslation = z
  .object({
    language: z.string().describe("The language's code").meta({ examples: ["de"] }),
    name: nameOutput.meta({ examples: ["Funktionswünsche"] }),
    description: z.string().nullable().describe("Its description there (null as for name)").meta({ examples: ["Was wir als Nächstes bauen sollen."] }),
    keepUpToDate: keepUpToDateOutput,
  })
  .describe("A board's name and description in one of the project's languages");

/** `sample`: not translated (a sample collection; a board readers don't see, while they don't). */
type Label = { name: string; description: string; translations: unknown; sample: boolean };

/**
 * What a label shows in a language: a translation only while it's current (labelIn), and whether it's kept up to date. One
 * with none yet is, where the job will make it: the language Automatic for new pages (`automatic`), AI on, not a sample.
 */
function translationIn(label: Label, code: string, automatic: boolean) {
  const translation = (label.translations as LabelTranslations | null)?.[code];
  const current = !!translation && (!translation.auto || translation.source === labelSource(label.name, label.description));
  return {
    language: code,
    name: current ? translation.name : null,
    description: current ? (translation.description ?? "") : null,
    keepUpToDate: translation ? translation.auto : automatic && aiEnabled() && !label.sample,
  };
}

/**
 * A label's text and translations (a tab's description empty, never a sample; a board's description empty for none, a
 * sample while it's off or the team's alone), as the labels job reads it.
 */
async function labelFor(db: Prisma.TransactionClient | typeof prisma, kind: Kind, projectId: string, slug: string, lock = false): Promise<(Label & { id: string }) | null> {
  const forUpdate = lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
  const [row] =
    kind === COLLECTION
      ? await db.$queryRaw<(Label & { id: string })[]>`SELECT id, name, description, translations, sample FROM collection WHERE "projectId" = ${projectId} AND slug = ${slug} ${forUpdate}`
      : kind === TAB
        ? await db.$queryRaw<(Label & { id: string })[]>`SELECT id, name, '' AS description, translations, false AS sample FROM docs_tab WHERE "projectId" = ${projectId} AND slug = ${slug} ${forUpdate}`
        : await db.$queryRaw<(Label & { id: string })[]>`
            SELECT id, name, coalesce(description, '') AS description, translations, (off OR "postVisibility" = 'TEAM') AS sample
            FROM board WHERE "projectId" = ${projectId} AND slug = ${slug} ${forUpdate}`;
  return row ?? null;
}

/** A label's translations in each of the project's languages (in the order they were added), as get…Translations answers. */
async function translationsOf(kind: Kind, projectId: string, slug: string) {
  const [label, languages] = await Promise.all([
    labelFor(prisma, kind, projectId, slug),
    prisma.projectLanguage.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { code: "asc" }], select: { code: true, automatic: true } }),
  ]);
  if (!label) {
    throw new OperationError(404, "not_found", `There's no ${kind.noun} “${slug}”`);
  }
  return languages.map(({ code, automatic }) => translationIn(label, code, automatic));
}

/** A collection's translations, as collections.getTranslations answers. */
export const collectionTranslations = (projectId: string, slug: string) => translationsOf(COLLECTION, projectId, slug);
/** A tab's translation as its operations answer: no description. */
const tabOnly = ({ language, name, keepUpToDate }: ReturnType<typeof translationIn>) => ({ language, name, keepUpToDate });
/** A tab's translations, as tabs.getTranslations answers. */
export const tabTranslations = async (projectId: string, slug: string) => (await translationsOf(TAB, projectId, slug)).map(tabOnly);
/** A board's translations, as boards.getTranslations answers. */
export const boardTranslations = (projectId: string, slug: string) => translationsOf(BOARD, projectId, slug);

/**
 * A label's name (and a collection's or board's description) in one language: the team's own, or kept up to date (made again in the
 * background, readers seeing the default language's meanwhile).
 */
async function saveTranslation(kind: Kind, projectId: string, input: { slug: string; language: (typeof LANGUAGE_CODES)[number]; keepUpToDate: boolean; name?: string; description?: string }) {
  if (input.keepUpToDate && !aiEnabled()) {
    throw new OperationError(409, "ai_off", "Translating needs AI, and it's off on this server");
  }
  if (!input.keepUpToDate && !input.name) {
    throw new OperationError(400, "invalid_input", "Give it a name");
  }
  const saved = await prisma.$transaction(async (tx) => {
    // As the labels job's write locks them: the language's row (shared), then the label's.
    const [found] = await tx.$queryRaw<{ automatic: boolean }[]>`SELECT automatic FROM project_language WHERE "projectId" = ${projectId} AND code = ${input.language} FOR SHARE`;
    if (!found) {
      throw new OperationError(400, "invalid_input", `${LANGUAGES[input.language].name} isn't one of your languages`);
    }
    const row = await labelFor(tx, kind, projectId, input.slug, true);
    if (!row) {
      throw new OperationError(404, "not_found", `There's no ${kind.noun} “${input.slug}”`);
    }
    // Sample content is never translated (as sample articles aren't): only the team's own there. (A board readers don't
    // see may be kept up to date: it's translated once they do.)
    if (input.keepUpToDate && row.sample && kind === COLLECTION) {
      throw new OperationError(409, "sample", "Sample collections aren't translated: write its name there instead");
    }
    const was = (row.translations as LabelTranslations)[input.language];
    const source = labelSource(row.name, row.description);
    // What's there now, as readers get it: the team's own, or one kept up to date made from its text as it is (labelIn). An
    // old one (made from text since changed) is never kept as the team's: it would read as current, and never be made again.
    const current = !!was && (!was.auto || was.source === source);
    const description =
      kind.description ? { description: input.keepUpToDate ? (was?.description ?? "") : (input.description ?? (current ? (was.description ?? "") : "")) } : {};
    // Kept up to date: made again (its source cleared, so the job finds it), unless it's already current. The team's own: a
    // description left out stays as it was there.
    const entry: LabelTranslation = input.keepUpToDate
      ? { name: was?.name ?? "", ...description, auto: true, source: was?.auto && was.source === source ? was.source : null }
      : { name: input.name!, ...description, auto: false, source };
    const translations = { ...(row.translations as LabelTranslations), [input.language]: entry };
    // Raw, so its updatedAt (a board's is the sitemap's lastmod) stays its own text's last change, not a translation's.
    await tx.$executeRaw`UPDATE ${Prisma.raw(kind.table)} SET translations = ${JSON.stringify(translations)}::jsonb WHERE id = ${row.id}`;
    return { label: { ...row, translations }, automatic: found.automatic };
  });
  if (input.keepUpToDate) {
    await queueLabels(projectId, [input.language]);
  }
  return translationIn(saved.label, input.language, saved.automatic);
}

const collectionSlug = z.string().min(1).max(200).describe("The collection's slug").meta({ examples: ["basics"] });
const tabSlug = z.string().min(1).max(200).describe("The tab's slug").meta({ examples: ["guides"] });

export const getCollectionTranslations = defineOperation({
  name: "collections.getTranslations",
  title: "Get collection translations",
  summary: "A docs collection's name and description in each of the project's languages: the translation readers see, and whether it's kept up to date.",
  method: "GET",
  path: "/collections/{slug}/translations",
  scope: "read",
  access: "team",
  input: z.object({ slug: collectionSlug }),
  output: z.object({ translations: z.array(collectionTranslation).describe("One per language, in the project's order") }).describe("The collection's translations"),
  run: async ({ projectId }, { slug }) => ({ translations: await collectionTranslations(projectId, slug) }),
});

export const updateCollectionTranslation = defineOperation({
  name: "collections.updateTranslation",
  title: "Update collection translation",
  summary:
    "Set a docs collection's name and description in one of the project's languages: the team's own (never replaced), or kept up to date (`keepUpToDate`), translated again in the background from its name and description (costs credits where they're on).",
  method: "PATCH",
  path: "/collections/{slug}/translations/{language}",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: collectionSlug,
    language,
    keepUpToDate: z.boolean().describe("Kept up to date by AI (not for a sample collection, nor with AI off); the name and description sent are then left out").meta({ examples: [false] }),
    name: collectionName.optional().describe("Its name there, up to 60 characters (required unless kept up to date)").meta({ examples: ["Erste Schritte"] }),
    description: z.string().trim().max(300).optional().describe("Its description there, up to 300 characters; left out, it stays as it was there").meta({ examples: ["Die Grundlagen in fünf Minuten."] }),
  }),
  output: collectionTranslation,
  example: { keepUpToDate: false, name: "Erste Schritte", description: "Die Grundlagen in fünf Minuten." },
  run: ({ projectId }, input) => saveTranslation(COLLECTION, projectId, input),
});

export const getTabTranslations = defineOperation({
  name: "tabs.getTranslations",
  title: "Get tab translations",
  summary: "A docs tab's name in each of the project's languages: the translation readers see, and whether it's kept up to date.",
  method: "GET",
  path: "/tabs/{slug}/translations",
  scope: "read",
  access: "team",
  input: z.object({ slug: tabSlug }),
  output: z.object({ translations: z.array(tabTranslation).describe("One per language, in the project's order") }).describe("The tab's translations"),
  run: async ({ projectId }, { slug }) => ({ translations: await tabTranslations(projectId, slug) }),
});

export const updateTabTranslation = defineOperation({
  name: "tabs.updateTranslation",
  title: "Update tab translation",
  summary:
    "Set a docs tab's name in one of the project's languages: the team's own (never replaced), or kept up to date (`keepUpToDate`), translated again in the background from its name (costs credits where they're on).",
  method: "PATCH",
  path: "/tabs/{slug}/translations/{language}",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    slug: tabSlug,
    language,
    keepUpToDate: z.boolean().describe("Kept up to date by AI (not with AI off); the name sent is then left out").meta({ examples: [false] }),
    name: z.string().trim().min(1, "Name is required").max(40).optional().describe("Its name there, up to 40 characters (required unless kept up to date)").meta({ examples: ["Anleitungen"] }),
  }),
  output: tabTranslation,
  example: { keepUpToDate: false, name: "Anleitungen" },
  run: async ({ projectId }, input) => tabOnly(await saveTranslation(TAB, projectId, input)),
});

const boardSlug = z.string().min(1).max(200).describe("The board's slug").meta({ examples: ["feature-requests"] });

export const getBoardTranslations = defineOperation({
  name: "boards.getTranslations",
  title: "Get board translations",
  summary: "A feedback board's name and description in each of the project's languages: the translation readers see, and whether it's kept up to date.",
  method: "GET",
  path: "/boards/{slug}/translations",
  scope: "read",
  access: "team",
  input: z.object({ slug: boardSlug }),
  output: z.object({ translations: z.array(boardTranslation).describe("One per language, in the project's order") }).describe("The board's translations"),
  run: async ({ projectId }, { slug }) => ({ translations: await boardTranslations(projectId, slug) }),
});

export const updateBoardTranslation = defineOperation({
  name: "boards.updateTranslation",
  title: "Update board translation",
  summary:
    "Set a feedback board's name and description in one of the project's languages: the team's own (never replaced), or kept up to date (`keepUpToDate`), translated again in the background from its name and description (costs credits where they're on).",
  method: "PATCH",
  path: "/boards/{slug}/translations/{language}",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({
    slug: boardSlug,
    language,
    keepUpToDate: z.boolean().describe("Kept up to date by AI (not with AI off); the name and description sent are then left out").meta({ examples: [false] }),
    name: z.string().trim().min(2, "Name is too short").max(60).optional().describe("Its name there, 2 to 60 characters (required unless kept up to date)").meta({ examples: ["Funktionswünsche"] }),
    description: z.string().trim().max(280).optional().describe("Its description there, up to 280 characters; left out, it stays as it was there").meta({ examples: ["Was wir als Nächstes bauen sollen."] }),
  }),
  output: boardTranslation,
  example: { keepUpToDate: false, name: "Funktionswünsche", description: "Was wir als Nächstes bauen sollen." },
  run: ({ projectId }, input) => saveTranslation(BOARD, projectId, input),
});
