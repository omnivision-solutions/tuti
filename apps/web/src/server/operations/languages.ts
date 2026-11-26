import { prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { isLanguage, type Language, LANGUAGE_CODES, LANGUAGES, languageLimit, type PlanKey, planDisplay, upgradeFor } from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/** Languages (docs/plan.md, Languages): the project's default language, and the others its portal is in. */

export const MAX_LANGUAGE_INSTRUCTIONS = 2000;

const code = z.enum(LANGUAGE_CODES);

const languageOutput = z
  .object({
    code: code.describe("Its code").meta({ examples: ["de"] }),
    name: z.string().describe("Its name in English").meta({ examples: ["German"] }),
    newPages: z.enum(["automatic", "manual"]).describe("How new pages get this language: translated automatically, or written by the team").meta({ examples: ["automatic"] }),
    instructions: z.string().describe("The team's instructions for translating into it").meta({ examples: ["Use du, not Sie."] }),
    productAvailable: z.boolean().describe("“Our product is available in <language>”: the team's own product has its words in this language").meta({ examples: [false] }),
    live: z.boolean().describe("Whether readers get it; until then only the team can open its pages").meta({ examples: [false] }),
  })
  .meta({ id: "Language", description: "A language the portal is in besides its default one" });

const languagesOutput = z
  .object({
    default: z.object({ code: code.describe("Its code").meta({ examples: ["en"] }), name: z.string().describe("Its name in English").meta({ examples: ["English"] }) }).describe("The language the team writes in"),
    languages: z.array(languageOutput).describe("The other languages, in the order they were added"),
    sendVisitors: z.boolean().describe("“Send visitors to their language”: a first visit to the portal's home is to go to the live language the browser asks for (saved; not acted on until pages have an address per language)").meta({ examples: [false] }),
  })
  .describe("The portal's languages");

const languageSelect = { code: true, automatic: true, instructions: true, productAvailable: true, live: true } as const;

export async function projectLanguages(projectId: string): Promise<z.output<typeof languagesOutput>> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { plan: true, language: true, sendToLanguage: true, languages: { select: languageSelect, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
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
    sendVisitors: z.boolean().optional().describe("“Send visitors to their language”: a first visit to the portal's home is to go to the live language the browser asks for (off by default; saved, not acted on until pages have an address per language)"),
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
  await prisma.$transaction(async (tx) => {
    // One change at a time per project: the limit and the default language's rule hold for what's saved.
    await lockProject(tx, projectId);
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true, language: true, languages: { select: { code: true, live: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } } });
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
    await tx.projectLanguage.deleteMany({ where: { projectId, code: { in: LANGUAGE_CODES, notIn: input.languages.map(({ code }) => code) } } });
    // Those added together keep the list's order: a millisecond apart.
    // After every language already there, even one added a moment ago (a millisecond per language, maybe ahead of the clock).
    const latest = await tx.projectLanguage.aggregate({ where: { projectId }, _max: { createdAt: true } });
    const now = Math.max(Date.now(), (latest._max.createdAt?.getTime() ?? 0) + 1);
    for (const [index, { code, newPages, ...rest }] of input.languages.entries()) {
      const data = { ...(newPages && { automatic: newPages === "automatic" }), ...rest };
      await tx.projectLanguage.upsert({ where: { projectId_code: { projectId, code } }, create: { projectId, code, createdAt: new Date(now + index), ...data }, update: data });
    }
  });
  return projectLanguages(projectId);
}
