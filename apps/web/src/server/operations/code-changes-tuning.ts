import { prisma } from "@tuti/db";
import {
  clampTuning,
  planIncludes,
  savedTuning,
  serverCodeChangesSettings,
  settingAt,
  TUNING,
  TUNING_KEYS,
  type TuningKey,
  tuningRange,
  type TuningRange,
  type TuningValue,
} from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError, requireOwner } from "./define";
import { requirePlan } from "./plan";

/**
 * Autopilot's Advanced tuning (docs/plan.md, Autopilot's docs agent, D6): a project's own values for a few of Autopilot's
 * settings (code-changes-tuning.ts), owners only, on a plan with Advanced tuning. Each is the server's until the project sets it.
 */

export type CodeChangesTuning = {
  /** The project's plan includes Advanced tuning (always without plans): off it, its values are kept, not used. */
  available: boolean;
  /** Who changed the values last (their name; null once they're gone), and when; null before anyone did. */
  updatedBy: string | null;
  updatedAt: string | null;
  values: Record<
    TuningKey,
    {
      /** What analyses use now: the project's value where its plan has tuning, else the server's. */
      value: TuningValue;
      /** The server's: its CODE_CHANGES_* variable, else the default in code. */
      default: TuningValue;
      /** The project's value, inside the server's range now (null: none). */
      saved: TuningValue | null;
      /** The project's value was outside the range the server has now, so it's used (and shown) at its end. */
      clamped: boolean;
      range: TuningRange;
    }
  >;
};

export async function codeChangesTuning(projectId: string): Promise<CodeChangesTuning> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { plan: true, codeChangesTuning: true, tuningUpdatedAt: true, tuningEditor: { select: { name: true } } },
  });
  const server = serverCodeChangesSettings();
  const available = planIncludes(project.plan, "aiTuning");
  const stored = savedTuning(project.codeChangesTuning);
  const values = Object.fromEntries(
    TUNING_KEYS.map((key) => {
      const saved = clampTuning(key, stored[key], server) ?? null;
      const fallback = settingAt(server, key);
      return [
        key,
        {
          value: available && saved !== null ? saved : fallback,
          default: fallback,
          saved,
          clamped: saved !== null && saved !== stored[key],
          range: tuningRange(key, server),
        },
      ];
    }),
  ) as CodeChangesTuning["values"];
  return { available, updatedBy: project.tuningEditor?.name ?? null, updatedAt: project.tuningUpdatedAt?.toISOString() ?? null, values };
}

/** An example of each value, for the spec. */
const EXAMPLES: Record<TuningKey, { value: TuningValue; range: TuningRange }> = {
  "propose.edit.maybe": { value: 0.5, range: { kind: "probability", min: 0, max: 0.8 } },
  "propose.newArticle.maybe": { value: 0.5, range: { kind: "probability", min: 0, max: 0.8 } },
  "redecide.whenNewArticle": { value: 0.2, range: { kind: "probability", min: 0, max: 1 } },
  "decide.rounds": { value: 12, range: { kind: "integer", min: 1, max: 50 } },
  "write.rounds": { value: 10, range: { kind: "integer", min: 1, max: 50 } },
  "decide.reasoning": { value: "off", range: { kind: "options", options: ["off", "low", "medium", "high"] } },
  "context.diffChars": { value: 60000, range: { kind: "integer", min: 1000, max: 500000 } },
};

const valueOut = z.union([z.number(), z.string()]);
const rangeOut = z.union([
  z.object({ kind: z.enum(["probability", "integer"]), min: z.number(), max: z.number() }),
  z.object({ kind: z.literal("options"), options: z.array(z.string()) }),
]);

/** One value of the tuning as codeChangesTuning.get returns it, with its key's examples. */
const tuningEntryOut = (key: TuningKey) =>
  z
    .object({
      value: valueOut.describe("What analyses use now: the project's value where its plan has tuning, else the server's").meta({ examples: [EXAMPLES[key].value] }),
      default: valueOut.describe("The server's default: its CODE_CHANGES_* variable, else the one in code").meta({ examples: [EXAMPLES[key].value] }),
      saved: valueOut.nullable().describe("The project's own value, inside the server's range now; null for none").meta({ examples: [null] }),
      clamped: z.boolean().describe("The project's value was outside the server's range, so it's used (and shown) at its end").meta({ examples: [false] }),
      range: rangeOut.describe("What it may be: a probability or a whole number from `min` to `max`, or one of `options`").meta({ examples: [EXAMPLES[key].range] }),
    })
    .describe(TUNING[key].label);

const tuningOut = z
  .object({
    available: z
      .boolean()
      .describe("Whether the project's plan includes Advanced tuning (always without plans): off it, its values are kept, not used")
      .meta({ examples: [true] }),
    updatedBy: z.string().nullable().describe("Who changed the values last (their name; null once they're gone, or before anyone did)").meta({ examples: ["Olive Owner"] }),
    updatedAt: z.string().nullable().describe("When; null before anyone did").meta({ examples: ["2026-11-18T09:30:00.000Z"] }),
    values: z
      .object(Object.fromEntries(TUNING_KEYS.map((key) => [key, tuningEntryOut(key)])) as Record<TuningKey, ReturnType<typeof tuningEntryOut>>)
      .describe("Each value, by its path"),
  })
  .describe("Autopilot's Advanced tuning");

export const getCodeChangesTuning = defineOperation({
  name: "codeChangesTuning.get",
  title: "Get Autopilot's tuning",
  summary:
    "Get Autopilot's Advanced tuning: for each value, what analyses use, the server's default, the project's own and its range; whether the plan includes Advanced tuning, and who changed it last",
  method: "GET",
  path: "/code-changes-tuning",
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: tuningOut,
  run: ({ projectId }) => codeChangesTuning(projectId),
});

/** A value, or null to go back to the server's. Probabilities are 0 to 1; each is checked against the server's range when saved. */
const tuningValue = z.union([z.number(), z.string().trim().max(20), z.null()]).optional();
const tuningInput = Object.fromEntries(
  TUNING_KEYS.map((key) => [key, tuningValue.describe(`${TUNING[key].label}: ${TUNING[key].tradeoff} Inside the server's range (see codeChangesTuning.get), or null for the server's`)]),
) as Record<TuningKey, typeof tuningValue>;

/** "75%" for a probability, the number itself otherwise; a bound in whole percents inside the range, as the form offers it. */
const shown = (range: TuningRange, n: number, round: (n: number) => number) =>
  range.kind === "probability" ? `${round(Number((n * 100).toFixed(6)))}%` : n.toLocaleString("en-US");

export const updateCodeChangesTuning = defineOperation({
  name: "codeChangesTuning.update",
  title: "Update Autopilot's tuning",
  summary:
    "Change Autopilot's Advanced tuning (owners only; where plans are sold, on a plan with Advanced tuning, 402 otherwise): any of its values. Values left out keep theirs",
  method: "PATCH",
  path: "/code-changes-tuning",
  scope: "write",
  access: "owner",
  errors: [402],
  input: z.object(tuningInput),
  output: tuningOut,
  example: { "propose.edit.maybe": 0.4, "decide.rounds": 8, "decide.reasoning": null },
  run: async ({ actor, projectId }, input) => {
    const userId = await requireOwner(actor, projectId);
    await requirePlan(projectId, "aiTuning");
    const server = serverCodeChangesSettings();
    const given = Object.entries(input).filter((entry): entry is [TuningKey, TuningValue | null] => entry[1] !== undefined);
    for (const [key, value] of given) {
      const range = tuningRange(key, server);
      const ok =
        value === null ||
        (range.kind === "options"
          ? typeof value === "string" && range.options.includes(value)
          : typeof value === "number" && value >= range.min && value <= range.max && (range.kind === "probability" || Number.isInteger(value)));
      if (!ok) {
        const must =
          range.kind === "options"
            ? `one of ${range.options.join(", ")}`
            : `${range.kind === "integer" ? "a whole number" : "a probability"} from ${shown(range, range.min, Math.ceil)} to ${shown(range, range.max, Math.floor)}`;
        throw new OperationError(400, "invalid_input", `${TUNING[key].label} (${key}) must be ${must}`);
      }
    }
    // Nothing given, nothing changed: who changed it last stays as it was.
    if (given.length === 0) {
      return codeChangesTuning(projectId);
    }
    // Merged in the database, so two owners changing different values at once both keep theirs.
    const set = JSON.stringify(Object.fromEntries(given.filter(([, value]) => value !== null)));
    const unset = given.filter(([, value]) => value === null).map(([key]) => key);
    await prisma.$executeRaw`UPDATE "project" SET "codeChangesTuning" = ("codeChangesTuning" || ${set}::jsonb) - ${unset}::text[], "tuningUpdatedAt" = now(), "tuningUpdatedBy" = ${userId} WHERE "id" = ${projectId}`;
    return codeChangesTuning(projectId);
  },
});
