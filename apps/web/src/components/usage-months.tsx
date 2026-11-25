import { creditsEnabled } from "@tuti/shared";

import { SettingBlock, SettingsCard } from "@/components/settings-card";
import { AI_FEATURE_NAMES, costOf, count, credits, money } from "@/lib/usage-format";
import { aiUsageByMonth } from "@/server/operations/usage";

const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });

/** What the project's AI use cost each month (UTC), a row a feature: on Settings → Billing. */
export async function UsageMonths({ projectId }: { projectId: string }) {
  const months = await aiUsageByMonth(projectId, 12);
  // With credits on, the team sees what it was charged, not what the models cost the server.
  const inCredits = creditsEnabled();

  return (
    <div id="usage" className="flex scroll-mt-8 flex-col gap-7">
      {months.length === 0 ? (
        <SettingsCard title="AI usage">
          <SettingBlock>
            <p className="text-muted-foreground">No AI use yet.</p>
          </SettingBlock>
        </SettingsCard>
      ) : (
        months.map((month) => (
          <SettingsCard
            key={month.month}
            title={`AI usage · ${monthName(month.month)}`}
            description={
              <>
                {count(month.requests)} AI {month.requests === 1 ? "request" : "requests"}, {count(month.inputTokens + month.outputTokens)} tokens
                {month.unpriced > 0 && `; ${count(month.unpriced)} without a price from the provider${inCredits ? `, charged no credits` : ""}`}
              </>
            }
            action={<span className="shrink-0 text-sm font-medium tabular-nums">{inCredits ? `${credits(month.credits)} credits` : money(month.cost)}</span>}
          >
            <table className="w-full text-sm" aria-label={`AI use in ${monthName(month.month)}`}>
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="*:px-4 *:pt-3 *:pb-1 *:font-medium @min-[34rem]/settings:*:px-5">
                  <th>Feature</th>
                  <th className="text-right">Requests</th>
                  <th className="hidden text-right sm:table-cell">Tokens</th>
                  <th className="text-right">{inCredits ? "Credits" : "Cost"}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {month.features.map((feature) => (
                  <tr key={feature.feature} className="*:px-4 *:py-3 @min-[34rem]/settings:*:px-5">
                    <td className="font-medium">{AI_FEATURE_NAMES[feature.feature] ?? feature.feature}</td>
                    <td className="text-right tabular-nums">{count(feature.requests)}</td>
                    <td className="hidden text-right tabular-nums sm:table-cell">{count(feature.inputTokens + feature.outputTokens)}</td>
                    <td className="text-right tabular-nums">{inCredits ? credits(feature.credits) : costOf(feature)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SettingsCard>
        ))
      )}
    </div>
  );
}
