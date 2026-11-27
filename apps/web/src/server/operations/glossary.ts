import { prisma } from "@tuti/db";
import { applyGlossaryChanges, type GlossaryChanges, lockProject, planGlossaryChanges, projectGlossary } from "@tuti/jobs";
import { LANGUAGE_CODES } from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/** The glossary (docs/plan.md, Languages, L12): terms never translated, or translated one way per language. */

/** The most terms a glossary holds. */
export const MAX_GLOSSARY_TERMS = 500;
const MAX_TERM_LENGTH = 100;

const termOutput = z
  .object({
    term: z.string().describe("The term, as the team writes it").meta({ examples: ["Board"] }),
    keep: z.boolean().describe("Never translated, in any language").meta({ examples: [false] }),
    translations: z
      .record(z.string(), z.string())
      .describe("Its word in each language, by code; a language left out: the model decides")
      .meta({ examples: [{ de: "Board", fr: "Tableau" }] }),
  })
  .describe("A glossary term");

const glossaryOutput = z.object({ terms: z.array(termOutput).describe("The terms, by term") }).describe("The glossary");

export const getGlossary = defineOperation({
  name: "glossary.get",
  title: "Get the glossary",
  summary: "The glossary every translation follows: terms never translated, or translated one way per language.",
  method: "GET",
  path: "/glossary",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: glossaryOutput,
  run: async ({ projectId }) => ({ terms: await projectGlossary(projectId) }),
});

const termInput = z.object({
  term: z.string().trim().min(1).max(MAX_TERM_LENGTH).describe("The term, as the team writes it").meta({ examples: ["Board"] }),
  keep: z.boolean().optional().describe("Never translated, in any language (its translations are left out)").meta({ examples: [false] }),
  translations: z
    .partialRecord(z.enum(LANGUAGE_CODES), z.string().trim().max(MAX_TERM_LENGTH))
    .optional()
    .describe("Its word in each language, by code; a language left out (or empty): the model decides")
    .meta({ examples: [{ de: "Board", fr: "Tableau" }] }),
});

export const updateGlossary = defineOperation({
  name: "glossary.update",
  title: "Update the glossary",
  summary:
    "Replace the glossary's terms. Versions kept up to date that use a changed term are translated again in the background (costs credits where they're on); in the others, the sections that use one are marked behind. With `dryRun`, only says how many.",
  method: "PATCH",
  path: "/glossary",
  scope: "write",
  access: "admin",
  errors: [409],
  input: z.object({
    terms: z.array(termInput).max(MAX_GLOSSARY_TERMS).describe(`Every term (up to ${MAX_GLOSSARY_TERMS}); one left out is removed`),
    dryRun: z.boolean().optional().describe("Save nothing: only count what saving would translate again and mark behind"),
  }),
  output: glossaryOutput
    .extend({
      retranslating: z.number().int().describe("Versions kept up to date that use a changed term, translated again").meta({ examples: [3] }),
      behind: z.number().int().describe("Versions the team writes with sections marked behind for a changed term").meta({ examples: [1] }),
    })
    .describe("The glossary, and what saving it translates again or marks behind"),
  example: { terms: [{ term: "Acme", keep: true }, { term: "Board", translations: { de: "Board", fr: "Tableau" } }] },
  run: async ({ projectId }, { terms, dryRun = false }) => {
    const seen = new Set<string>();
    for (const { term } of terms) {
      if (seen.has(term.toLowerCase())) {
        throw new OperationError(400, "invalid_input", `“${term}” is in the glossary twice`);
      }
      seen.add(term.toLowerCase());
    }
    // A kept term has no translations; empty words are the model's to decide.
    const after = terms.map(({ term, keep = false, translations = {} }) => ({
      term,
      keep,
      translations: keep ? {} : (Object.fromEntries(Object.entries(translations).filter(([, word]) => word)) as Record<string, string>),
    }));
    // What saving changes, worked out before the transaction (matching terms against every source's text): only locks, reads
    // and writes run in it. Planned against the glossary as it was read; saved under the project's lock only if it still is
    // (another save in between: planned again).
    let changes: GlossaryChanges | null = null;
    for (let tries = 0; !changes; tries++) {
      const before = await projectGlossary(projectId);
      const plan = await planGlossaryChanges(projectId, before, after);
      changes = await prisma.$transaction(
        async (tx) => {
          await lockProject(tx, projectId);
          if (JSON.stringify(await projectGlossary(projectId, tx)) !== JSON.stringify(before)) {
            if (tries >= 2) throw new OperationError(409, "changed", "The glossary changed while saving. Try again");
            return null;
          }
          const applied = await applyGlossaryChanges(tx, plan, { dryRun });
          // Planned from sources that changed since (a publish, a version added): planned again.
          if (!applied) {
            if (tries >= 2) throw new OperationError(409, "changed", "The pages changed while saving. Try again");
            return null;
          }
          if (!dryRun) {
            await tx.glossaryTerm.deleteMany({ where: { projectId } });
            await tx.glossaryTerm.createMany({ data: after.map((term) => ({ projectId, ...term })) });
          }
          return applied;
        },
        { timeout: 30_000 },
      );
    }
    if (!dryRun) {
      await changes.queue();
    }
    return { terms: dryRun ? after.sort((a, b) => a.term.localeCompare(b.term)) : await projectGlossary(projectId), retranslating: changes.retranslated, behind: changes.behind };
  },
});
