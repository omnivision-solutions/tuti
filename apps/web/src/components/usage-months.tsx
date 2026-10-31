import { creditsEnabled } from "@tuti/shared";

import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AI_FEATURE_NAMES, costOf, count, credits, money } from "@/lib/usage-format";
import { aiUsageByMonth } from "@/server/operations/usage";

const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });

/** What the project's AI use cost each month, by feature: on Settings → Billing. */
export async function UsageMonths({ projectId }: { projectId: string }) {
  const months = await aiUsageByMonth(projectId, 12);
  // With AI credits on, the team sees what it was charged, not what the models cost the server.
  const inCredits = creditsEnabled();

  return (
    <section id="usage" aria-labelledby="usage-heading" className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="usage-heading" className="font-heading text-base font-medium">
          Usage
        </h2>
        <p className="text-sm text-muted-foreground">
          Every AI request this project made, and what it cost{inCredits && " in AI credits"}, by month (UTC).
        </p>
      </div>
      {months.length === 0 ? (
        <EmptyState title="No AI use yet" description="AI answers, changelog drafts and Autopilot show up here, with what they cost, once they're used." />
      ) : (
        months.map((month) => (
          <Card key={month.month}>
            <CardHeader>
              <CardTitle>
                {monthName(month.month)}: {inCredits ? `${credits(month.credits)} credits` : money(month.cost)}
              </CardTitle>
              <CardDescription>
                {count(month.requests)} AI {month.requests === 1 ? "request" : "requests"}, {count(month.inputTokens + month.outputTokens)} tokens
                {month.unpriced > 0 &&
                  `; ${count(month.unpriced)} without a price from the provider${inCredits ? `, charged no credits` : ""}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm" aria-label={`AI use in ${monthName(month.month)}`}>
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Feature</th>
                    <th className="pb-2 text-right font-medium">Requests</th>
                    <th className="hidden pb-2 text-right font-medium sm:table-cell">Tokens</th>
                    <th className="pb-2 text-right font-medium">{inCredits ? "Credits" : "Cost"}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {month.features.map((feature) => (
                    <tr key={feature.feature}>
                      <td className="py-2">{AI_FEATURE_NAMES[feature.feature] ?? feature.feature}</td>
                      <td className="py-2 text-right tabular-nums">{count(feature.requests)}</td>
                      <td className="hidden py-2 text-right tabular-nums sm:table-cell">{count(feature.inputTokens + feature.outputTokens)}</td>
                      <td className="py-2 text-right tabular-nums">{inCredits ? credits(feature.credits) : costOf(feature)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))
      )}
    </section>
  );
}
