import Link from "next/link";
import { notFound } from "next/navigation";

import { ItemList, ItemRow } from "@/components/item-list";
import { count, DailyChart, percent, ReportHeading, Stat, Stats } from "@/components/reports";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { docsReport, INSIGHTS_DAYS } from "@/server/operations/reports";

export const metadata = { title: "Feedback · Reporting" };

/** Reporting → Docs → Feedback: readers' answers to "Was this helpful?" under articles, and what those who said "No" missed. */
export default async function ReportingFeedbackPage(props: PageProps<"/app/[project]/reporting/feedback">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const report = await docsReport(membership.project.id);
  const { totals } = report;
  return (
    <>
      <ReportHeading section="Docs" title="Feedback" days={INSIGHTS_DAYS} />
      <Stats>
        <Stat label="Helpful" value={count(totals.helpful)} hint="Readers who answered “Yes”" />
        <Stat label="Not helpful" value={count(totals.notHelpful)} hint="Readers who answered “No”" />
        <Stat label="Found it helpful" value={percent(totals.helpful, totals.helpful + totals.notHelpful)} hint="Share of answers that were “Yes”" />
      </Stats>
      <DailyChart
        title="Answers by day"
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
    </>
  );
}
