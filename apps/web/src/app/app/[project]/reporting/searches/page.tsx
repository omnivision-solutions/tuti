import Link from "next/link";
import { notFound } from "next/navigation";

import { DismissGapButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { count, DailyChart, percent, plural, ReportHeading, searchesSince, Stat, Stats } from "@/components/reports";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { reportRange } from "@/lib/report-range";
import { getMembership } from "@/server/membership";
import { docsReport } from "@/server/operations/reports";

export const metadata = { title: "Searches · Reporting" };

/** Reporting → Docs → Searches: how often readers searched, and what found nothing (a topic to write about, or to dismiss). */
export default async function ReportingSearchesPage(props: PageProps<"/app/[project]/reporting/searches">) {
  const [{ project: slug }, { range: given }] = await Promise.all([props.params, props.searchParams]);
  const range = reportRange(typeof given === "string" ? given : undefined);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const report = await docsReport(membership.project.id, range);
  const { totals } = report;
  return (
    <>
      <ReportHeading section="Help center" title="Searches" range={range.key} />
      <Stats>
        <Stat label="Searches" value={count(totals.searches)} hint={searchesSince(report.searchesSince) ?? "Portal, widget and API"} />
        <Stat label="Found nothing" value={count(totals.failedSearches)} hint={searchesSince(report.searchesSince) ?? "Searches without a single result"} />
        <Stat label="Found something" value={percent(totals.searches - totals.failedSearches, totals.searches)} hint="Searches with a result" />
      </Stats>
      <DailyChart
        title="Searches"
        days={report.days}
        series={[
          { label: "Found something", values: report.daily.searches.map((searches, i) => searches - report.daily.failed[i]!) },
          { label: "Found nothing", values: report.daily.failed },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>Searches that found nothing</CardTitle>
          <CardDescription>Topics to write about, most searched first.</CardDescription>
        </CardHeader>
        <CardContent>
          {report.failedSearches.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every search found something.</p>
          ) : (
            <ItemList aria-label="Searches that found nothing">
              {report.failedSearches.map((search) => (
                <ItemRow
                  key={search.query}
                  wideActions
                  title={search.query}
                  // Still counted in Found nothing: marked, so the list adds up to it.
                  badges={search.dismissed && <Badge variant="secondary">Dismissed</Badge>}
                  meta={`${plural(search.count, "search", "searches")}${search.before > 0 && !search.dismissed ? `, ${count(search.before)} before you dismissed it` : ""}`}
                  actions={
                    <>
                      <Link
                        href={`/app/${slug}/docs/new?${new URLSearchParams({ title: search.query })}`}
                        aria-label={`Write an article about “${search.query}”`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        Write an article
                      </Link>
                      {!search.dismissed && <DismissGapButton projectSlug={slug} question={search.query} />}
                    </>
                  }
                />
              ))}
            </ItemList>
          )}
        </CardContent>
      </Card>
    </>
  );
}
