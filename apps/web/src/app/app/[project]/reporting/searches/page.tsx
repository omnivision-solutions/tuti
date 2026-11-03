import Link from "next/link";
import { notFound } from "next/navigation";

import { DismissGapButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { count, DailyChart, percent, plural, ReportHeading, Stat, Stats } from "@/components/reports";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getMembership } from "@/server/membership";
import { docsReport, INSIGHTS_DAYS } from "@/server/operations/reports";

export const metadata = { title: "Searches · Reporting" };

/** Reporting → Docs → Searches: how often readers searched, and what found nothing (a topic to write about, or to dismiss). */
export default async function ReportingSearchesPage(props: PageProps<"/app/[project]/reporting/searches">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const report = await docsReport(membership.project.id);
  const { totals } = report;
  return (
    <>
      <ReportHeading section="Docs" title="Searches">
        What readers searched your docs for in the last {INSIGHTS_DAYS} days, and what found nothing.
      </ReportHeading>
      <Stats>
        <Stat label="Searches" value={count(totals.searches)} hint="Searches on the portal and in the widget" />
        <Stat label="Found nothing" value={count(totals.failedSearches)} hint="Searches without a single result" />
        <Stat label="Found something" value={percent(totals.searches - totals.failedSearches, totals.searches)} hint="Searches with a result" />
      </Stats>
      <DailyChart
        title="Searches by day"
        days={report.days}
        series={[
          { label: "Found something", values: report.daily.searches.map((searches, i) => searches - report.daily.failed[i]!) },
          { label: "Found nothing", values: report.daily.failed },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>Searches that found nothing</CardTitle>
          {/* Why only these: what readers search for isn't kept otherwise (see DocsFailedSearchDay). */}
          <CardDescription>
            Topics to write about, most searched first. Only searches that found nothing keep their words. Dismissing one hides it from
            Unanswered questions too, until it&apos;s searched or asked again.
          </CardDescription>
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
                  meta={plural(search.count, "search", "searches")}
                  actions={
                    <>
                      <Link
                        href={`/app/${slug}/docs/new?${new URLSearchParams({ title: search.query })}`}
                        aria-label={`Write an article about “${search.query}”`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        Write an article
                      </Link>
                      <DismissGapButton projectSlug={slug} question={search.query} />
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
