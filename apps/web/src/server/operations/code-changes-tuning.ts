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
 * settings (code-changes-tuning.ts), owners only, on Business. Each is the server's until the project sets it.
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

const description = TUNING_KEYS.map((key) => `${key} (${TUNING[key].label})`).join(", ");

export const getCodeChangesTuning = defineOperation({
  name: "codeChangesTuning.get",
  summary: `Get Autopilot's Advanced tuning: for each value (${description}) what analyses use, the server's default, the project's own (null for none) and its range; whether the plan includes it (Business), and who changed it last`,
  method: "GET",
  path: "/code-changes-tuning",
  scope: "read",
  access: "admin",
  input: z.object({}),
  run: ({ projectId }) => codeChangesTuning(projectId),
});

/** A value, or null to go back to the server's. Probabilities are 0 to 1; each is checked against the server's range when saved. */
const tuningValue = z.union([z.number(), z.string().trim().max(20), z.null()]).optional();

/** "75%" for a probability, the number itself otherwise. */
const shown = (range: TuningRange, n: number) => (range.kind === "probability" ? `${Math.round(n * 100)}%` : n.toLocaleString("en-US"));

export const updateCodeChangesTuning = defineOperation({
  name: "codeChangesTuning.update",
  summary:
    "Change Autopilot's Advanced tuning (owners only, on the Business plan): any of its values, each inside the server's range (see codeChangesTuning.get), or null for the server's. Values left out keep theirs",
  method: "PATCH",
  path: "/code-changes-tuning",
  scope: "write",
  access: "owner",
  input: z.object(Object.fromEntries(TUNING_KEYS.map((key) => [key, tuningValue])) as Record<TuningKey, typeof tuningValue>),
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
            : `${range.kind === "integer" ? "a whole number" : "a probability"} from ${shown(range, range.min)} to ${shown(range, range.max)}`;
        throw new OperationError(400, "invalid_input", `${TUNING[key].label} (${key}) must be ${must}`);
      }
    }
    // Merged in the database, so two owners changing different values at once both keep theirs.
    const set = JSON.stringify(Object.fromEntries(given.filter(([, value]) => value !== null)));
    const unset = given.filter(([, value]) => value === null).map(([key]) => key);
    await prisma.$executeRaw`UPDATE "project" SET "codeChangesTuning" = ("codeChangesTuning" || ${set}::jsonb) - ${unset}::text[], "tuningUpdatedAt" = now(), "tuningUpdatedBy" = ${userId} WHERE "id" = ${projectId}`;
    return codeChangesTuning(projectId);
  },
});
