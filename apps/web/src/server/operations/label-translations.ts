import { Prisma, prisma } from "@tuti/db";
import { type LabelTranslation, type LabelTranslations, labelSource, queueLabels } from "@tuti/jobs";
import { aiEnabled, collectionName, LANGUAGE_CODES, LANGUAGES } from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/**
 * Labels' translations (docs/plan.md, Languages, L13): a docs collection's name and description in each of the project's
 * languages, as its settings' Translations show them. Kept up to date (made by the translate-labels job, made again when
 * its text changes) or the team's own (never replaced).
 */

const language = z.enum(LANGUAGE_CODES).describe("The language's code (one of the project's languages)").meta({ examples: ["de"] });
const collectionSlug = z.string().min(1).max(200).describe("The collection's slug").meta({ examples: ["basics"] });

const translationOutput = z
  .object({
    language: z.string().describe("The language's code").meta({ examples: ["de"] }),
    name: z.string().nullable().describe("Its name there: the translation readers see (null: none yet, readers see the default language's)").meta({ examples: ["Erste Schritte"] }),
    description: z.string().nullable().describe("Its description there (null as for name)").meta({ examples: ["Die Grundlagen in fünf Minuten."] }),
    keepUpToDate: z.boolean().describe("Made and kept up to date by AI (else the team's own, never replaced)").meta({ examples: [true] }),
  })
  .describe("A collection's name and description in one of the project's languages");

/**
 * What a label shows in a language: a translation only while it's current (labelIn), and whether it's kept up to date. One
 * with none yet is, where the job will make it: the language Automatic for new pages (`automatic`), AI on, not a sample.
 */
function translationIn(label: { name: string; description: string; translations: unknown; sample: boolean }, code: string, automatic: boolean) {
  const translation = (label.translations as LabelTranslations | null)?.[code];
  const current = !!translation && (!translation.auto || translation.source === labelSource(label.name, label.description));
  return {
    language: code,
    name: current ? translation.name : null,
    description: current ? (translation.description ?? "") : null,
    keepUpToDate: translation ? translation.auto : automatic && aiEnabled() && !label.sample,
  };
}

async function collectionFor(projectId: string, slug: string) {
  const collection = await prisma.collection.findUnique({ where: { projectId_slug: { projectId, slug } }, select: { name: true, description: true, translations: true, sample: true } });
  if (!collection) {
    throw new OperationError(404, "not_found", `There's no collection “${slug}”`);
  }
  return collection;
}

/** A collection's translations in each of the project's languages (in the order they were added), as getCollectionTranslations answers. */
export async function collectionTranslations(projectId: string, slug: string) {
  const [collection, languages] = await Promise.all([
    collectionFor(projectId, slug),
    prisma.projectLanguage.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { code: "asc" }], select: { code: true, automatic: true } }),
  ]);
  return languages.map(({ code, automatic }) => translationIn(collection, code, automatic));
}

export const getCollectionTranslations = defineOperation({
  name: "collections.getTranslations",
  title: "Get collection translations",
  summary: "A docs collection's name and description in each of the project's languages: the translation readers see, and whether it's kept up to date.",
  method: "GET",
  path: "/collections/{slug}/translations",
  scope: "read",
  access: "team",
  input: z.object({ slug: collectionSlug }),
  output: z.object({ translations: z.array(translationOutput).describe("One per language, in the project's order") }).describe("The collection's translations"),
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
  output: translationOutput,
  example: { keepUpToDate: false, name: "Erste Schritte", description: "Die Grundlagen in fünf Minuten." },
  run: async ({ projectId }, input) => {
    if (input.keepUpToDate && !aiEnabled()) {
      throw new OperationError(409, "ai_off", "Translating needs AI, and it's off on this server");
    }
    if (!input.keepUpToDate && !input.name) {
      throw new OperationError(400, "invalid_input", "Give it a name");
    }
    const saved = await prisma.$transaction(async (tx) => {
      // As the labels job's write locks them: the language's row (shared), then the collection's.
      const [found] = await tx.$queryRaw<{ code: string }[]>`SELECT code FROM project_language WHERE "projectId" = ${projectId} AND code = ${input.language} FOR SHARE`;
      if (!found) {
        throw new OperationError(400, "invalid_input", `${LANGUAGES[input.language].name} isn't one of your languages`);
      }
      const [row] = await tx.$queryRaw<{ id: string; name: string; description: string; translations: LabelTranslations; sample: boolean }[]>`
        SELECT id, name, description, translations, sample FROM collection WHERE "projectId" = ${projectId} AND slug = ${input.slug} FOR UPDATE`;
      if (!row) {
        throw new OperationError(404, "not_found", `There's no collection “${input.slug}”`);
      }
      // Sample content is never translated (as sample articles aren't): only the team's own there.
      if (input.keepUpToDate && row.sample) {
        throw new OperationError(409, "sample", "Sample collections aren't translated: write its name there instead");
      }
      const was = row.translations[input.language];
      // What's there now, as readers get it: the team's own, or one kept up to date made from its text as it is (labelIn).
      // An old one (made from text since changed) is never kept as the team's: it would read as current, and never be made again.
      const current = !!was && (!was.auto || was.source === labelSource(row.name, row.description));
      // Kept up to date: made again (its source cleared, so the job finds it), readers seeing the default language's meanwhile.
      const entry: LabelTranslation = input.keepUpToDate
        ? { name: was?.name ?? "", description: was?.description ?? "", auto: true, source: was?.auto && was.source === labelSource(row.name, row.description) ? was.source : null }
        : // A description left out stays as it was there.
          { name: input.name!, description: input.description ?? (current ? (was.description ?? "") : ""), auto: false, source: labelSource(row.name, row.description) };
      const translations = { ...row.translations, [input.language]: entry };
      await tx.collection.update({ where: { id: row.id }, data: { translations: translations as Prisma.InputJsonValue } });
      const { automatic } = await tx.projectLanguage.findUniqueOrThrow({ where: { projectId_code: { projectId, code: input.language } }, select: { automatic: true } });
      return { name: row.name, description: row.description, translations, sample: row.sample, automatic };
    });
    if (input.keepUpToDate) {
      await queueLabels(projectId, [input.language]);
    }
    return translationIn(saved, input.language, saved.automatic);
  },
});
