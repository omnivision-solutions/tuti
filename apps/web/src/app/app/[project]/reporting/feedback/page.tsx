import Link from "next/link";

import { ItemList, ItemRow } from "@/components/item-list";
import { count, countTrend, DailyChart, helpfulTrend, percent, ReportBody, ReportHeading, Stat, Stats } from "@/components/reports";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { docsReport } from "@/server/operations/reports";
import { reportingPage, sampleDocsReport } from "@/server/reporting";

export const metadata = { title: "Feedback · Reporting" };

/** Reporting → Docs → Feedback: readers' answers to "Was this helpful?" under articles, and what those who said "No" missed. */
export default async function ReportingFeedbackPage(props: PageProps<"/app/[project]/reporting/feedback">) {
  const [{ project: slug }, { range: given }] = await Promise.all([props.params, props.searchParams]);
  const { membership, range, locked, sample, upgrade } = await reportingPage(slug, given);
  const report = sample ? sampleDocsReport(range) : await docsReport(membership.project.id, range);
  const { totals } = report;
  return (
    <ReportBody upgrade={upgrade}>
      <ReportHeading section="Help center" title="Feedback" range={range.key} locked={locked} />
      <Stats compared={range}>
        <Stat label="Helpful" value={count(totals.helpful)} hint="Readers who answered “Yes”" trend={countTrend(range, report.daily.helpful, report.before.helpful, "up")} />
        <Stat label="Not helpful" value={count(totals.notHelpful)} hint="Readers who answered “No”" trend={countTrend(range, report.daily.notHelpful, report.before.notHelpful, "down")} />
        <Stat label="Found it helpful" value={percent(totals.helpful, totals.helpful + totals.notHelpful)} hint="Share of answers that were “Yes”" trend={helpfulTrend(range, report)} />
      </Stats>
      <DailyChart
        title="Answers"
        days={report.days}
        series={[
          { label: "Helpful", values: report.daily.helpful },
          { label: "Not helpful", values: report.daily.notHelpful },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>What readers missed</CardTitle>
          <CardDescription>The latest comments from readers who answered “No”.</CardDescription>
        </CardHeader>
        <CardContent>
          {report.comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          ) : (
            <ItemList aria-label="What readers missed">
              {report.comments.map((comment) => (
                <ItemRow
                  key={`${comment.article.slug}-${comment.at}`}
                  title={<span className="font-normal">{comment.comment}</span>}
                  meta={
                    <>
                      <Link href={`/app/${slug}/docs/${comment.article.slug}`} className="hover:underline">
                        {comment.article.title}
                      </Link>
                      {` · ${timeAgo(new Date(comment.at))}`}
                    </>
                  }
                />
              ))}
            </ItemList>
          )}
        </CardContent>
      </Card>
    </ReportBody>
  );
}
