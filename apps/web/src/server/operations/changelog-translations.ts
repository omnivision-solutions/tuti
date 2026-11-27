import type { Doc } from "@tuti/content";
import { prisma } from "@tuti/db";
import { queueEntryVersion, translationSource } from "@tuti/jobs";
import { contentHash, LANGUAGE_CODES, LANGUAGES, MAX_ENTRY_LENGTH } from "@tuti/shared";
import { z } from "zod";

import { attachMedia, displayDoc, readContent } from "../content";
import { defineOperation, OperationError } from "./define";

/**
 * A changelog entry's version in another language, for its editor's language pill (docs/plan.md L16): read it, and save
 * the team's text (which stops Keep up to date, so a translation never replaces it) or turn Keep up to date back on (it's
 * translated again from the entry as it is). An entry is translated whole, so it has no sections of its own, unlike an
 * article's version.
 */

const entryNumber = z.coerce.number().int().positive().describe("The entry's number in the project").meta({ examples: [7] });
const language = z.enum(LANGUAGE_CODES).describe("The language's code: one of the project's other languages").meta({ examples: ["de"] });
const docExample = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wechsle das Design im Profilmenü." }] }] };

const translationOutput = z
  .object({
    language: z.string().describe("The language's code").meta({ examples: ["de"] }),
    keepUpToDate: z.boolean().describe("Translated again each time the entry's text changes; off, it's the team's to write").meta({ examples: [true] }),
    title: z.string().describe("Its title (empty until it's written or translated)").meta({ examples: ["Dunkler Modus"] }),
    content: z.record(z.string(), z.unknown()).nullable().describe("Its text: the editor's JSON document (null until it's written or translated)").meta({ examples: [docExample] }),
    publishedAt: z.iso.datetime().nullable().describe("When it was first written or translated: until then readers get the default language's").meta({ examples: ["2026-11-27T09:00:00.000Z"] }),
    behind: z.boolean().describe("The entry's text, or the language's \"Our product is available in\", changed since it was written or translated").meta({ examples: [false] }),
    waiting: z.string().nullable().describe("Why it couldn't be translated (it's tried again), or null").meta({ examples: [null] }),
    version: z.string().describe("What it says now, for changelog.saveTranslation's `version`: a save made from an older read is refused").meta({ examples: ["5f2c9a…"] }),
  })
  .describe("A changelog entry's version in another language");

const versionSelect = { automatic: true, title: true, body: true, content: true, publishedAt: true, sourceHash: true, error: true, behind: true } as const;
type Version = { automatic: boolean; title: string; body: string; content: unknown; publishedAt: Date | null; sourceHash: string | null; error: string | null; behind: unknown };

/** What a version says now (none: there's no version yet), for a save's `version`. */
const versionToken = (version: Version | null) => contentHash(JSON.stringify(version ? [version.automatic, version.title, version.content, version.publishedAt] : null));

function output(code: string, version: Version | null, sourceHash: string): z.output<typeof translationOutput> {
  return {
    language: code,
    // No version yet: nothing translates it until it's turned on (or the entry's text changes).
    keepUpToDate: version?.automatic ?? false,
    title: version?.title ?? "",
    content: version?.publishedAt ? (displayDoc(version) as Record<string, unknown>) : null,
    publishedAt: version?.publishedAt?.toISOString() ?? null,
    // Made from other text, or marked behind (the product setting changed: markProductSettingBehind).
    behind: !!version?.publishedAt && (version.sourceHash !== sourceHash || Object.keys((version.behind as object | null) ?? {}).length > 0),
    waiting: version?.error ?? null,
    version: versionToken(version),
  };
}

/** The entry and the project's setting for `code` (404s for neither), and the entry's source hash. */
async function entryAndLanguage(projectId: string, number: number, code: (typeof LANGUAGE_CODES)[number]) {
  const [entry, setting] = await Promise.all([
    prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: { id: true, title: true, body: true, content: true, publishedAt: true } }),
    prisma.projectLanguage.findUnique({ where: { projectId_code: { projectId, code } }, select: { code: true } }),
  ]);
  if (!entry) {
    throw new OperationError(404, "not_found", `There's no changelog entry #${number}`);
  }
  if (!setting) {
    throw new OperationError(404, "not_found", `${LANGUAGES[code].name} isn't one of the project's languages`);
  }
  return { entry, setting, sourceHash: translationSource(entry).hash };
}

export const getChangelogTranslation = defineOperation({
  name: "changelog.getTranslation",
  title: "Get a changelog entry's translation",
  summary: "A changelog entry's version in one of the project's other languages: its title and text, whether it's kept up to date, and whether the entry changed since.",
  method: "GET",
  path: "/changelog/{number}/languages/{language}",
  scope: "read",
  access: "team",
  input: z.object({ number: entryNumber, language }),
  output: translationOutput,
  run: async ({ projectId }, input) => {
    const { entry, sourceHash } = await entryAndLanguage(projectId, input.number, input.language);
    const version = await prisma.changelogTranslation.findUnique({ where: { entryId_language: { entryId: entry.id, language: input.language } }, select: versionSelect });
    return output(input.language, version, sourceHash);
  },
});

export const saveChangelogTranslation = defineOperation({
  name: "changelog.saveTranslation",
  title: "Save a changelog entry's translation",
  summary:
    "Write a published changelog entry's version in another language (it stops being kept up to date, so a translation never replaces it), or turn Keep up to date on (translated again from the entry as it is) or off.",
  method: "PATCH",
  path: "/changelog/{number}/languages/{language}",
  scope: "write",
  access: "team",
  errors: [409],
  input: z.object({
    number: entryNumber,
    language,
    title: z.string().trim().min(1).max(120).optional().describe("Its title (with `content`; left out: as it is)").meta({ examples: ["Dunkler Modus"] }),
    content: z.unknown().optional().describe("Its text: the editor's JSON document (the changelog profile)").meta({ examples: [docExample] }),
    keepUpToDate: z.boolean().optional().describe("Turn Keep up to date on (it's translated again) or off. Not with `title` or `content`, which turn it off").meta({ examples: [true] }),
    version: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("With `title` or `content`: the `version` of the read the edit was made from; refused (409 `changed`) if it changed since (translated, or saved by someone else)")
      .meta({ examples: ["5f2c9a…"] }),
  }),
  output: translationOutput,
  run: async ({ projectId }, input) => {
    const writing = input.title !== undefined || input.content !== undefined;
    if (writing && input.keepUpToDate !== undefined) {
      throw new OperationError(400, "invalid_input", "Send the text, or Keep up to date, not both: writing it turns Keep up to date off");
    }
    if (writing && input.version === undefined) {
      throw new OperationError(400, "invalid_input", "Send the `version` you read it at with the text");
    }
    const { entry } = await entryAndLanguage(projectId, input.number, input.language);
    if (!entry.publishedAt) {
      throw new OperationError(409, "not_published", "Publish the entry first: its other languages are made from what's published");
    }
    const text = input.content !== undefined ? await readContent("changelog", { content: input.content }, { projectId, maxLength: MAX_ENTRY_LENGTH }) : null;
    if (text?.error !== undefined) {
      throw new OperationError(400, "invalid_content", text.error);
    }
    const where = { entryId_language: { entryId: entry.id, language: input.language } };
    const saved = await prisma.$transaction(async (tx) => {
      // The entry locked, as the translate job locks it to write: neither loses the other's write.
      const [locked] = await tx.$queryRaw<{ title: string; body: string; content: unknown }[]>`SELECT title, body, content FROM changelog_entry WHERE id = ${entry.id} FOR UPDATE`;
      const sourceHash = translationSource({ ...locked!, content: locked!.content as Doc | null }).hash;
      const version = await tx.changelogTranslation.findUnique({ where, select: versionSelect });
      if (writing) {
        if (versionToken(version) !== input.version) {
          throw new OperationError(409, "changed", "It changed since you opened it (translated, or saved by someone else). Reload it to see the changes.");
        }
        const title = input.title ?? version?.title ?? "";
        if (!title) {
          throw new OperationError(400, "invalid_input", "Give it a title first");
        }
        if (!text && !version?.publishedAt) {
          throw new OperationError(400, "invalid_input", "Write its text first");
        }
        if (text) {
          await attachMedia(tx, projectId, text.mediaIds);
        }
        // Made from the entry as it is now (the team wrote it beside it, under the product setting as it is: nothing behind);
        // the team's from now on.
        const data = {
          automatic: false,
          title,
          ...(text && { body: text.text, content: text.doc }),
          publishedAt: version?.publishedAt ?? new Date(),
          sourceHash,
          behind: {},
          error: null,
          tries: 0,
          retryAt: null,
        };
        return { version: await tx.changelogTranslation.upsert({ where, create: { entryId: entry.id, projectId, language: input.language, ...data }, update: data, select: versionSelect }), queue: false };
      }
      if (input.keepUpToDate === undefined) {
        return { version, queue: false };
      }
      // Off with no version yet: nothing to keep, and the language's setting says what a new one is.
      if (!version && !input.keepUpToDate) {
        return { version, queue: false };
      }
      // Turned on, it's translated anew (a Retranslate, nothing reused): the team's text, made from the entry as it is, would
      // otherwise read as up to date to the job.
      const on = input.keepUpToDate && !(version?.automatic ?? false);
      const updated = await tx.changelogTranslation.upsert({
        where,
        create: { entryId: entry.id, projectId, language: input.language, automatic: input.keepUpToDate },
        update: { automatic: input.keepUpToDate, ...(on && { retranslate: { increment: 1 } }) },
        select: versionSelect,
      });
      return { version: updated, queue: on };
    });
    // Turned on: translated again from the entry as it is (the safety net set first, so the retry job has it if this run is lost).
    if (saved.queue) {
      await queueEntryVersion(entry.id, input.language);
    }
    const now = await prisma.changelogEntry.findUniqueOrThrow({ where: { id: entry.id }, select: { title: true, body: true, content: true } });
    return output(input.language, saved.version, translationSource(now).hash);
  },
});
