import { prisma } from "@tuti/db";
import { lockProject, markProductSettingBehind, queueLanguageTranslations } from "@tuti/jobs";
import { aiEnabled, isLanguage, type Language, LANGUAGE_CODES, LANGUAGES, languageLimit, type PlanKey, planDisplay, upgradeFor } from "@tuti/shared";
import { z } from "zod";

import { forgetLanguages } from "../language-addresses";

import { defineOperation, OperationError } from "./define";

/** Languages (docs/plan.md, Languages): the project's default language, and the others its portal is in. */

export const MAX_LANGUAGE_INSTRUCTIONS = 2000;

const code = z.enum(LANGUAGE_CODES);

/** How many of a kind of page (`pages`) have a version in a language, and wait for one. */
const translations = (pages: string) =>
  z.object({
    translated: z.number().int().describe(`${pages} with a version in it`).meta({ examples: [42] }),
    waiting: z.number().int().describe(`${pages} kept up to date in it that wait for a translation (being translated, or couldn't be)`).meta({ examples: [0] }),
    why: z.string().nullable().describe("Why some wait, when they couldn't be translated (tried again on their own)").meta({ examples: ["Out of credits"] }),
  });

const languageOutput = z
  .object({
    code: code.describe("Its code").meta({ examples: ["de"] }),
    name: z.string().describe("Its name in English").meta({ examples: ["German"] }),
    newPages: z.enum(["automatic", "manual"]).describe("How new pages get this language: translated automatically, or written by the team").meta({ examples: ["automatic"] }),
    instructions: z.string().describe("The team's instructions for translating into it").meta({ examples: ["Use du, not Sie."] }),
    productAvailable: z.boolean().describe("“Our product is available in <language>”: the team's own product has its words in this language").meta({ examples: [false] }),
    live: z.boolean().describe("Whether readers get it; until then only the team can open its pages").meta({ examples: [false] }),
    articles: translations("Articles").describe("Its articles' translations"),
    entries: translations("Published changelog entries").describe("Its changelog entries' translations"),
  })
  .meta({ id: "Language", description: "A language the portal is in besides its default one" });

const languagesOutput = z
  .object({
    default: z.object({ code: code.describe("Its code").meta({ examples: ["en"] }), name: z.string().describe("Its name in English").meta({ examples: ["English"] }) }).describe("The language the team writes in"),
    languages: z.array(languageOutput).describe("The other languages, in the order they were added"),
    sendVisitors: z.boolean().describe("“Send visitors to their language”: a first visit to the portal's home (no language chosen in that browser yet) goes to the live language the browser asks for").meta({ examples: [false] }),
  })
  .describe("The portal's languages");

/** Why pages wait on a server with no AI set up: nothing translates them until it is. */
export const NO_AI = "AI isn't set up on this server";

const languageSelect = { code: true, automatic: true, instructions: true, productAvailable: true, live: true } as const;

export async function projectLanguages(projectId: string): Promise<z.output<typeof languagesOutput>> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { plan: true, language: true, sendToLanguage: true, languages: { select: languageSelect, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
  });
  // Counted against the published pages (Settings' `pages`): a sample, unpublished or deleted article's version isn't one.
  const live = { publishedAt: { not: null }, sample: false };
  const [translated, waiting, reasons, entriesTranslated, entriesWaiting, entryReasons] = await Promise.all([
    prisma.articleTranslation.groupBy({ by: ["language"], where: { projectId, publishedAt: { not: null }, article: { ...live, deletedAt: null } }, _count: true }),
    prisma.articleTranslation.groupBy({
      by: ["language"],
      where: { projectId, automatic: true, article: live, OR: [{ publishedAt: null }, { error: { not: null } }] },
      _count: true,
    }),
    prisma.articleTranslation.groupBy({ by: ["language", "error"], where: { projectId, automatic: true, error: { not: null }, article: live }, _count: true, orderBy: { _count: { id: "desc" } } }),
    prisma.changelogTranslation.groupBy({ by: ["language"], where: { projectId, publishedAt: { not: null }, entry: live }, _count: true }),
    prisma.changelogTranslation.groupBy({ by: ["language"], where: { projectId, automatic: true, entry: live, OR: [{ publishedAt: null }, { error: { not: null } }] }, _count: true }),
    prisma.changelogTranslation.groupBy({ by: ["language", "error"], where: { projectId, automatic: true, error: { not: null }, entry: live }, _count: true, orderBy: { _count: { id: "desc" } } }),
  ]);
  const count = (rows: { language: string; _count: number }[], code: string) => rows.find((row) => row.language === code)?._count ?? 0;
  // The most common reason first.
  const counts = (done: typeof translated, left: typeof waiting, why: typeof reasons, code: string) => ({
    translated: count(done, code),
    waiting: count(left, code),
    why: why.find((row) => row.language === code)?.error ?? (count(left, code) > 0 && !aiEnabled() ? NO_AI : null),
  });
  // Past the plan's limit (after a downgrade) only the oldest within it are live; the rest are kept, offline until an upgrade.
  const limit = languageLimit(project.plan);
  const named = (code: string) => (isLanguage(code) ? { code, name: LANGUAGES[code].name } : null);
  return {
    default: named(project.language) ?? { code: "en", name: LANGUAGES.en.name },
    // A code no longer offered isn't one this server can serve.
    languages: project.languages.flatMap(({ code, ...rest }) => {
      const language = named(code);
      return language ? [{ ...rest, ...language }] : [];
    }).map(({ automatic, live, ...rest }, index) => ({
      ...rest,
      articles: counts(translated, waiting, reasons, rest.code),
      entries: counts(entriesTranslated, entriesWaiting, entryReasons, rest.code),
      newPages: automatic ? ("automatic" as const) : ("manual" as const),
      // Counted among those offered only.
      live: live && (limit === null || index < limit - 1),
    })),
    sendVisitors: project.sendToLanguage,
  };
}

/** Said when a project on `plan` has as many languages as its plan's `limit` allows (also Settings' upgrade prompts: `then`, "make more live"). */
export const languagesFull = (plan: PlanKey, limit: number, then = "add more") =>
  [
    `Projects on the ${planDisplay(plan).name} plan have ${limit === 1 ? "1 language" : `up to ${limit} languages`}, the default included.`,
    upgradeFor(plan, languageLimit, ` in Settings → Billing to ${then}.`),
  ]
    .filter(Boolean)
    .join(" ");

export const getLanguages = defineOperation({
  name: "languages.get",
  title: "Get the languages",
  summary: "The portal's languages: the default one the team writes in, and the others with how each is translated and whether it's live.",
  method: "GET",
  path: "/languages",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: languagesOutput,
  run: async ({ projectId }) => projectLanguages(projectId),
});

const updateInput = z
  .object({
    default: code.optional().describe("The language the team writes in (409 while the project has other languages)").meta({ examples: ["en"] }),
    languages: z
      .array(
        z.object({
          code: code.describe("Its code").meta({ examples: ["de"] }),
          newPages: z.enum(["automatic", "manual"]).optional().describe("How new pages get it: translated automatically (a new language's default), or written by the team"),
          instructions: z
            .string()
            .trim()
            .max(MAX_LANGUAGE_INSTRUCTIONS, "Keep the instructions under 2,000 characters")
            .optional()
            .describe("Instructions for translating into it, up to 2,000 characters")
            .meta({ examples: ["Use du, not Sie."] }),
          productAvailable: z.boolean().optional().describe("“Our product is available in <language>” (off for a new language)"),
          live: z.boolean().optional().describe("Readers get it (off for a new language, so the team can check it first)"),
        }),
      )
      .max(LANGUAGE_CODES.length - 1)
      .optional()
      .describe("The other languages, in full (the plan's limit counts the default too, so it's included in how many)"),
    sendVisitors: z.boolean().optional().describe("“Send visitors to their language”: a first visit to the portal's home (no language chosen in that browser yet) goes to the live language the browser asks for (off by default)"),
  })
  .refine((input) => input.default !== undefined || input.languages !== undefined || input.sendVisitors !== undefined, "Send default, languages or sendVisitors")
  .refine((input) => new Set(input.languages?.map(({ code }) => code)).size === (input.languages?.length ?? 0), "Each language once")
  .meta({ anyOf: [{ required: ["default"] }, { required: ["languages"] }, { required: ["sendVisitors"] }] });

type UpdateInput = z.output<typeof updateInput>;

export const updateLanguages = defineOperation({
  name: "languages.update",
  title: "Update the languages",
  summary:
    "Change the default language (only while it's the only one), sending visitors to their language, or the other languages: the list in full, a language left out is removed and a new one added (offline, automatic for new pages). Fields left out keep their value. The plan limits how many (402).",
  method: "PATCH",
  path: "/languages",
  scope: "write",
  access: "admin",
  errors: [402, 409],
  input: updateInput,
  example: { languages: [{ code: "de", newPages: "automatic", instructions: "Use du, not Sie." }] },
  output: languagesOutput,
  run: async ({ projectId }, input) => changeLanguages(projectId, () => input),
});

/**
 * Saves the languages as `change` makes them from the saved ones (the codes this release offers, oldest first), read
 * and saved under the project's lock, so changes made at once never undo each other (Settings' one-language actions).
 * What `change` returns is checked as `languages.update`'s input.
 */
export async function changeLanguages(projectId: string, change: (current: Language[]) => z.input<typeof updateInput>) {
  // Languages added, and those whose "Our product is available in" changed: their articles are translated once saved.
  const added: string[] = [];
  const switched: string[] = [];
  await prisma.$transaction(async (tx) => {
    // One change at a time per project: the limit and the default language's rule hold for what's saved.
    await lockProject(tx, projectId);
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true, language: true, languages: { select: { code: true, live: true, productAvailable: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } } });
    const current = project.languages.map(({ code }) => code);
    const parsed = updateInput.safeParse(change(current.filter(isLanguage)));
    if (!parsed.success) {
      throw new OperationError(400, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const input: UpdateInput = parsed.data;
    const language = input.default ?? project.language;
    if (language !== project.language && current.length > 0) {
      throw new OperationError(409, "conflict", "Remove the other languages first: the default language changes only while it's the only one");
    }
    if (!input.languages) {
      await tx.project.update({ where: { id: projectId }, data: { language, sendToLanguage: input.sendVisitors } });
      return;
    }
    const clash = input.languages.find(({ code }) => code === language);
    if (clash) {
      throw new OperationError(400, "invalid_input", `${LANGUAGES[clash.code].name} is the default language`);
    }
    // Past the limit (after a downgrade) a project keeps its languages and can change or remove them, but add none,
    // and only its oldest within the limit can go live (the rest read as offline: see projectLanguages).
    const limit = languageLimit(project.plan);
    if (limit !== null && 1 + input.languages.length > limit) {
      // The oldest of those it keeps.
      const within = current.filter((code) => input.languages?.some((language) => language.code === code)).slice(0, limit - 1);
      if (input.languages.some(({ code, live }) => !current.includes(code) || (live && !within.includes(code)))) {
        throw new OperationError(402, "plan_required", languagesFull(project.plan, limit));
      }
    }
    await tx.project.update({ where: { id: projectId }, data: { language, sendToLanguage: input.sendVisitors } });
    // Only languages this release offers: one it doesn't know (a newer release's, during a deploy) can't be in the list, so it stays.
    const removed = { projectId, code: { in: LANGUAGE_CODES, notIn: input.languages.map(({ code }) => code) } };
    // A removed language's versions go with it, but their addresses stay as old slugs, so /de/docs/<slug> still finds the
    // article (and sends it to the default language's page, as for an offline language).
    const kept = await tx.articleTranslation.findMany({ where: { projectId, language: removed.code, slug: { not: null }, article: { deletedAt: null } }, select: { language: true, slug: true, articleId: true } });
    await tx.articleOldSlug.createMany({ data: kept.map(({ language, slug, articleId }) => ({ projectId, language, slug: slug!, articleId })), skipDuplicates: true });
    await tx.projectLanguage.deleteMany({ where: removed });
    // Those added together keep the list's order: a millisecond apart.
    // After every language already there, even one added a moment ago (a millisecond per language, maybe ahead of the clock).
    const latest = await tx.projectLanguage.aggregate({ where: { projectId }, _max: { createdAt: true } });
    const now = Math.max(Date.now(), (latest._max.createdAt?.getTime() ?? 0) + 1);
    for (const [index, { code, newPages, ...rest }] of input.languages.entries()) {
      const saved = project.languages.find((language) => language.code === code);
      const flipped = saved !== undefined && rest.productAvailable !== undefined && rest.productAvailable !== saved.productAvailable;
      // Counted, so a translate job that started under the other setting writes nothing (see @tuti/jobs translateArticle).
      const data = { ...(newPages && { automatic: newPages === "automatic" }), ...rest, ...(flipped && { productVersion: { increment: 1 } }) };
      await tx.projectLanguage.upsert({ where: { projectId_code: { projectId, code } }, create: { projectId, code, createdAt: new Date(now + index), ...data, productVersion: 0 }, update: data });
      if (!saved) added.push(code);
      if (flipped) {
        // Versions kept up to date are retranslated once it's saved (below); jobs already running write nothing.
        await markProductSettingBehind(tx, projectId, code);
        switched.push(code);
      }
    }
  });
  // The proxy's copy catches up within its few seconds (server/language-addresses.ts).
  const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } });
  forgetLanguages(slug);
  for (const code of [...added, ...switched]) {
    await queueLanguageTranslations(projectId, code);
  }
  return projectLanguages(projectId);
}

export const retranslateLanguage = defineOperation({
  name: "languages.retranslate",
  title: "Retranslate a language",
  summary:
    "Translate a language's articles and changelog entries kept up to date again, in the background: all of them anew (Retranslate), or with `waiting`, only those that couldn't be translated yet (Try again). Costs credits where they're on.",
  method: "POST",
  path: "/languages/{code}/retranslate",
  scope: "write",
  access: "admin",
  errors: [404],
  input: z.object({
    code: code.describe("The language's code").meta({ examples: ["de"] }),
    waiting: z.boolean().optional().describe("Only the articles and entries waiting for a translation (Try again)"),
  }),
  output: z.object({ queued: z.number().int().describe("How many articles and entries are being translated").meta({ examples: [42] }) }).describe("What was queued"),
  run: async ({ projectId }, { code, waiting = false }) => {
    const language = await prisma.projectLanguage.findUnique({ where: { projectId_code: { projectId, code } }, select: { code: true } });
    if (!language) {
      throw new OperationError(404, "not_found", "The project doesn't have that language");
    }
    return { queued: await queueLanguageTranslations(projectId, code, { fresh: !waiting, waiting }) };
  },
});
