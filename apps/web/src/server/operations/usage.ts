import { type AiFeature } from "@tuti/jobs";
import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation } from "./define";

/** What the project's AI use cost (docs/plan.md, AI usage per project), month by month. */

type Totals = { requests: number; inputTokens: number; outputTokens: number; cost: number; unpriced: number };
export type UsageMonth = Totals & { month: string; features: (Totals & { feature: AiFeature })[] };

/** The last `months` calendar months (UTC), newest first: totals and each feature's, most expensive first. Months with no use are left out. */
export async function aiUsageByMonth(projectId: string, months: number): Promise<UsageMonth[]> {
  const rows = await prisma.$queryRaw<
    { month: string; feature: AiFeature; requests: bigint; inputTokens: bigint; outputTokens: bigint; cost: number | null; unpriced: bigint }[]
  >`
    -- createdAt is a UTC timestamp without a zone: truncated as it is, whatever the session's zone.
    SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month, feature,
      count(*) AS requests, sum("inputTokens") AS "inputTokens", sum("outputTokens") AS "outputTokens",
      sum(cost)::float8 AS cost, count(*) FILTER (WHERE cost IS NULL) AS unpriced
    FROM ai_usage
    WHERE "projectId" = ${projectId}
      AND "createdAt" >= date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => ${months - 1})
    GROUP BY 1, 2
    ORDER BY 1 DESC, 6 DESC NULLS LAST`;
  const byMonth = new Map<string, UsageMonth>();
  for (const row of rows) {
    const feature = {
      feature: row.feature,
      requests: Number(row.requests),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cost: row.cost ?? 0,
      unpriced: Number(row.unpriced),
    };
    const month = byMonth.get(row.month) ?? { month: row.month, requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpriced: 0, features: [] };
    month.features.push(feature);
    month.requests += feature.requests;
    month.inputTokens += feature.inputTokens;
    month.outputTokens += feature.outputTokens;
    month.cost += feature.cost;
    month.unpriced += feature.unpriced;
    byMonth.set(row.month, month);
  }
  return [...byMonth.values()];
}

export const getUsage = defineOperation({
  name: "usage.get",
  summary:
    "What the project's AI use cost, by calendar month (UTC, newest first) and feature: requests, tokens in and out, and the cost in dollars (`unpriced`: requests whose provider gave no price)",
  method: "GET",
  path: "/usage",
  scope: "read",
  access: "admin",
  input: z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }),
  example: { months: 3 },
  run: async ({ projectId }, input) => ({ months: await aiUsageByMonth(projectId, input.months) }),
});
