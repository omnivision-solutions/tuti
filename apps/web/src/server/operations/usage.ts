import { prisma } from "@tuti/db";
import { creditsEnabled, USAGE_FEATURES } from "@tuti/shared";
import { z } from "zod";

import { defineOperation } from "./define";

/** What the project's AI use cost (docs/plan.md, AI usage per project), and its emails paid with credits, month by month. */

/** `credits`: what was charged, with credits on. */
type Totals = { requests: number; inputTokens: number; outputTokens: number; cost: number; credits: number; unpriced: number };
/** What usage is listed for: the AI's features, and emails past the plan's included ones, paid with credits (`requests`: emails). */
const USAGE_KINDS = [...USAGE_FEATURES, "emails"] as const;
type UsageKind = (typeof USAGE_KINDS)[number];
export type UsageMonth = Totals & { month: string; features: (Totals & { feature: UsageKind })[] };

/**
 * The last `months` calendar months (UTC) up to `now`'s, newest first: totals and each feature's, most expensive first.
 * Months with no use are left out. The window starts from `now` as the app has it, not the database's clock.
 */
export async function aiUsageByMonth(projectId: string, months: number, now = new Date()): Promise<UsageMonth[]> {
  // The first day (UTC) of the earliest month shown.
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const rows = await prisma.$queryRaw<
    { month: string; feature: UsageKind; requests: bigint; inputTokens: bigint; outputTokens: bigint; cost: number | null; credits: number | null; unpriced: bigint }[]
  >`
    -- createdAt is a UTC timestamp without a zone: truncated as it is, whatever the session's zone.
    SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month, feature,
      count(*) AS requests, sum("inputTokens") AS "inputTokens", sum("outputTokens") AS "outputTokens",
      sum(cost)::float8 AS cost, sum(credits)::float8 AS credits, count(*) FILTER (WHERE cost IS NULL) AS unpriced
    FROM ai_usage
    WHERE "projectId" = ${projectId}
      AND "createdAt" >= ${since}
    GROUP BY 1, 2
    UNION ALL
    SELECT to_char(month, 'YYYY-MM'), 'emails', "paidEmails", 0, 0, 0, "paidCredits"::float8, 0
    FROM project_email_month
    WHERE "projectId" = ${projectId} AND "paidEmails" > 0
      AND month >= ${since}::date
    -- Most expensive first: by credits, which emails have and no cost (with credits off, by cost).
    ORDER BY 1 DESC, 7 DESC NULLS LAST, 6 DESC NULLS LAST`;
  const byMonth = new Map<string, UsageMonth>();
  for (const row of rows) {
    const feature = {
      feature: row.feature,
      requests: Number(row.requests),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cost: row.cost ?? 0,
      credits: row.credits ?? 0,
      unpriced: Number(row.unpriced),
    };
    const month = byMonth.get(row.month) ?? { month: row.month, requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, credits: 0, unpriced: 0, features: [] };
    month.features.push(feature);
    month.cost += feature.cost;
    month.credits += feature.credits;
    byMonth.set(row.month, month);
    // Emails are no AI requests: in the month's cost and credits only.
    if (row.feature === "emails") {
      continue;
    }
    month.requests += feature.requests;
    month.inputTokens += feature.inputTokens;
    month.outputTokens += feature.outputTokens;
    month.unpriced += feature.unpriced;
  }
  return [...byMonth.values()];
}

/** A month's use as the team sees it: with credits on, what it was charged in credits, and not what the models cost the server. */
const forTeam = <T extends Totals>({ cost, credits, ...totals }: T) => (creditsEnabled() ? { ...totals, credits } : { ...totals, cost });

/** A month's or a feature's totals, as getUsage returns them: the cost, or with credits on, the credits charged. */
const usageTotals = z.object({
  requests: z.number().int().describe("Requests to the AI").meta({ examples: [128] }),
  inputTokens: z.number().int().describe("Tokens sent to the model").meta({ examples: [512000] }),
  outputTokens: z.number().int().describe("Tokens the model wrote").meta({ examples: [64000] }),
  cost: z.number().optional().describe("What it cost in dollars, by its provider's price (left out on a server with credits)").meta({ examples: [1.84] }),
  credits: z.number().optional().describe("The credits charged (AI use, and emails past the plan's included ones), on a server with credits, instead of the cost").meta({ examples: [184] }),
  unpriced: z.number().int().describe("Requests whose provider gave no price, so the cost leaves them out").meta({ examples: [0] }),
});

export const getUsage = defineOperation({
  name: "usage.get",
  title: "Get usage",
  summary: "What the project's AI use cost, and its emails past the plan's included ones paid with credits, by calendar month (UTC, newest first) and by feature. Months with no use are left out.",
  method: "GET",
  path: "/usage",
  scope: "read",
  access: "admin",
  input: z.object({
    months: z.coerce.number().int().min(1).max(24).default(12).describe("How many calendar months back, this one included: 1 to 24 (default 12)").meta({ examples: [3] }),
  }),
  output: z
    .object({
      months: z
        .array(
          usageTotals
            .extend({
              month: z.string().describe("The calendar month (UTC), YYYY-MM").meta({ examples: ["2026-11"] }),
              features: z
                .array(
                  usageTotals
                    .extend({ feature: z.enum(USAGE_KINDS).describe("What the AI was used for, or `emails`: emails past the plan's included ones, paid with credits (`requests` counts them)").meta({ examples: ["answers"] }) })
                    .meta({ id: "AiFeatureUsage", description: "A feature's AI use in a month, or the emails paid with credits" }),
                )
                .describe("Each feature's use that month, most expensive first"),
            })
            .meta({ id: "AiUsageMonth", description: "A month's use: its totals and each feature's (emails paid with credits count in its credits only)" }),
        )
        .describe("Each month with use, newest first"),
    })
    .describe("The project's AI use by month"),
  example: { months: 3 },
  run: async ({ projectId }, input) => ({
    months: (await aiUsageByMonth(projectId, input.months)).map(({ features, ...month }) => ({ ...forTeam(month), features: features.map(forTeam) })),
  }),
});
