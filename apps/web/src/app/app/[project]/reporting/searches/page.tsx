import Link from "next/link";

import { DismissGapButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { count, countTrend, DailyChart, percent, plural, ReportBody, ReportHeading, searchesSince, shareTrend, Stat, Stats } from "@/components/reports";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { docsReport } from "@/server/operations/reports";
import { reportingPage, sampleDocsReport } from "@/server/reporting";

export const metadata = { title: "Searches · Reporting" };

/** Reporting → Docs → Searches: how often readers searched, and what found nothing (a topic to write about, or to dismiss). */
export default async function ReportingSearchesPage(props: PageProps<"/app/[project]/reporting/searches">) {
  const [{ project: slug }, { range: given }] = await Promise.all([props.params, props.searchParams]);
  const { membership, range, locked, sample, upgrade } = await reportingPage(slug, given);
  const report = sample ? sampleDocsReport(range) : await docsReport(membership.project.id, range);
  const { totals, before } = report;
  const found = report.daily.searches.map((searches, i) => searches - report.daily.failed[i]!);
  const unlisted = totals.failedSearches - report.failedSearches.reduce((sum, search) => sum + search.count, 0);
  return (
    <ReportBody upgrade={upgrade}>
      <ReportHeading section="Help center" title="Searches" range={range.key} locked={locked} />
      <Stats compared={range}>
        <Stat label="Searches" value={count(totals.searches)} hint={searchesSince(report.searchesSince) ?? "Portal, widget and API"} trend={countTrend(range, report.daily.searches, before.searches, "up")} />
        <Stat label="Found nothing" value={count(totals.failedSearches)} hint={searchesSince(report.searchesSince) ?? "Searches without a single result"} trend={countTrend(range, report.daily.failed, before.failedSearches, "down")} />
        <Stat label="Found something" value={percent(totals.searches - totals.failedSearches, totals.searches)} hint="Searches with a result"
          trend={shareTrend(range, found, report.daily.searches, before.searches === null ? null : { part: before.searches - before.failedSearches!, whole: before.searches }, "up")}
        />
      </Stats>
      <DailyChart
        title="Searches"
        days={report.days} today={range.today}
        series={[
          { label: "Found something", values: found },
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
                  badges={search.dismissed && <Badge variant="outline">Dismissed</Badge>}
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
          {/* The 50 most searched are listed; the rest (and those past a day's kept words) are counted, so the card adds up to Found nothing. */}
          {unlisted > 0 && <p className="mt-3 text-sm text-muted-foreground">And {plural(unlisted, "more search", "more searches")} that found nothing.</p>}
        </CardContent>
      </Card>
    </ReportBody>
  );
}
