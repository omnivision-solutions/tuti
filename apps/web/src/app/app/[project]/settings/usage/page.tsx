import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AI_FEATURE_NAMES, costOf, count, money } from "@/lib/usage-format";
import { getAdminProject } from "@/server/membership";
import { aiUsageByMonth } from "@/server/operations/usage";

const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });

/** Settings → Usage: what the project's AI use cost each month, by feature. */
export default async function UsageSettingsPage(props: PageProps<"/app/[project]/settings/usage">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const months = await aiUsageByMonth(project.id, 12);

  return (
    <>
      <p className="text-sm text-muted-foreground">Every AI request this project made, and what it cost, by month (UTC).</p>
      {months.length === 0 ? (
        <EmptyState title="No AI use yet" description="AI answers, changelog drafts and code changes show up here, with what they cost, once they're used." />
      ) : (
        months.map((month) => (
      <Card key={month.month}>
        <CardHeader>
          <CardTitle>
            {monthName(month.month)}: {money(month.cost)}
          </CardTitle>
          <CardDescription>
            {count(month.requests)} AI {month.requests === 1 ? "request" : "requests"}, {count(month.inputTokens + month.outputTokens)} tokens
            {month.unpriced > 0 && `; ${count(month.unpriced)} without a price from the provider`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm" aria-label={`AI use in ${monthName(month.month)}`}>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Feature</th>
                <th className="pb-2 text-right font-medium">Requests</th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">Tokens</th>
                <th className="pb-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {month.features.map((feature) => (
                <tr key={feature.feature}>
                  <td className="py-2">{AI_FEATURE_NAMES[feature.feature] ?? feature.feature}</td>
                  <td className="py-2 text-right tabular-nums">{count(feature.requests)}</td>
                  <td className="hidden py-2 text-right tabular-nums sm:table-cell">{count(feature.inputTokens + feature.outputTokens)}</td>
                  <td className="py-2 text-right tabular-nums">{costOf(feature)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
        ))
      )}
    </>
  );
}
