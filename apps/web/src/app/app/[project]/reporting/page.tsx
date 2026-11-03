import Link from "next/link";
import { notFound } from "next/navigation";

import { ItemList, ItemRow } from "@/components/item-list";
import { count, DailyChart, percent, plural, ReportHeading, Stat, Stats } from "@/components/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { reportRange, withRange } from "@/lib/report-range";
import { getMembership } from "@/server/membership";
import { docsReport } from "@/server/operations/reports";

export const metadata = { title: "Reporting" };

/** Reporting → Docs → Overview: how much the docs were read, searched and found helpful, and the most read articles. */
export default async function ReportingOverviewPage(props: PageProps<"/app/[project]/reporting">) {
  const [{ project: slug }, { range: given }] = await Promise.all([props.params, props.searchParams]);
  const range = reportRange(typeof given === "string" ? given : undefined);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const report = await docsReport(membership.project.id, range);
  const { totals } = report;
  const base = `/app/${slug}/reporting`;
  const read = report.articles.filter((article) => article.views > 0).slice(0, 5);
  return (
    <>
      <ReportHeading section="Help center" title="Overview" range={range.key} />
      <Stats>
        <Stat label="Article views" value={count(totals.views)} hint="Articles opened on the portal" href={withRange(`${base}/articles`, range.key)} />
        <Stat label="Searches" value={count(totals.searches)} hint="Searches of your docs" href={withRange(`${base}/searches`, range.key)} />
        <Stat label="Searches that found nothing" value={count(totals.failedSearches)} hint="Topics to write about" href={withRange(`${base}/searches`, range.key)} />
        <Stat
          label="Found it helpful"
          value={percent(totals.helpful, totals.helpful + totals.notHelpful)}
          hint={`${plural(totals.helpful + totals.notHelpful, "answer", "answers")} to “Was this helpful?”`}
          href={withRange(`${base}/feedback`, range.key)}
        />
      </Stats>
      <DailyChart title="Article views" days={report.days} series={[{ label: "Article views", values: report.daily.views }]} />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Most read articles</CardTitle>
          <Link href={withRange(`${base}/articles`, range.key)} className="text-sm text-muted-foreground hover:text-foreground">
            All articles
          </Link>
        </CardHeader>
        <CardContent>
          {read.length === 0 ? (
            <p className="text-sm text-muted-foreground">No article has been read yet.</p>
          ) : (
            <ItemList aria-label="Most read articles">
              {read.map((article) => (
                <ItemRow
                  key={article.slug}
                  title={
                    <Link href={`/app/${slug}/docs/${article.slug}`} className="hover:underline">
                      {article.title}
                    </Link>
                  }
                  meta={article.collection ?? "In no collection"}
                  actions={<span className="text-sm tabular-nums">{plural(article.views, "view", "views")}</span>}
                />
              ))}
            </ItemList>
          )}
        </CardContent>
      </Card>
    </>
  );
}
