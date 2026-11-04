import { cn } from "cn";
import Link from "next/link";

import { count, countTrend, helpfulTrend, percent, plural, ReportBody, ReportHeading, Stat, Stats } from "@/components/reports";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { withRange } from "@/lib/report-range";
import { docsReport } from "@/server/operations/reports";
import { reportingPage, sampleDocsReport } from "@/server/reporting";

export const metadata = { title: "Articles · Reporting" };

/** Reporting → Docs → Articles: every published article (and any other read lately) with its views and answers to "Was this helpful?". */
const SORTS = ["views", "rate", "helpful", "notHelpful"] as const;
type Sort = (typeof SORTS)[number];

/** The share of an article's answers that were "Yes", or null with none. */
const rateOf = ({ helpful, notHelpful }: { helpful: number; notHelpful: number }) => (helpful + notHelpful === 0 ? null : helpful / (helpful + notHelpful));

export default async function ReportingArticlesPage(props: PageProps<"/app/[project]/reporting/articles">) {
  const [{ project: slug }, { sort: given, range: rangeGiven }] = await Promise.all([props.params, props.searchParams]);
  const sort: Sort = SORTS.find((by) => by === given) ?? "views";
  const { membership, range, locked, sample, upgrade } = await reportingPage(slug, rangeGiven);
  const report = sample ? sampleDocsReport(range) : await docsReport(membership.project.id, range);
  const { totals, articles: read } = report;
  // Counts the most first; the helpful rate the least first (what readers find unhelpful), those without answers last; most read first
  // among equals (the report's order).
  const articles =
    sort === "views"
      ? read
      : sort === "rate"
        ? read.toSorted((a, b) => (rateOf(a) ?? 2) - (rateOf(b) ?? 2))
        : read.toSorted((a, b) => b[sort] - a[sort]);
  /**
   * A column's heading: a link that sorts by it, marked while it does. On phones, Views only (the answers are in each row's meta line);
   * the rest from tablet width up.
   */
  const sortHeading = (by: Sort, label: string) => (
    <th
      scope="col"
      aria-sort={sort === by ? (by === "rate" ? "ascending" : "descending") : undefined}
      className={cn("pb-2 pl-4 text-right font-medium", by !== "views" && "max-md:hidden")}
    >
      <Link href={withRange(by === "views" ? "?" : `?sort=${by}`, range.key)} scroll={false} className={sort === by ? "text-foreground underline underline-offset-4" : "hover:text-foreground"}>
        {label}
      </Link>
    </th>
  );
  return (
    <ReportBody upgrade={upgrade}>
      <ReportHeading section="Help center" title="Articles" range={range.key} locked={locked} />
      <Stats compared={range}>
        <Stat label="Article views" value={count(totals.views)} hint="Articles opened on the portal" trend={countTrend(range, report.daily.views, report.before.views, "up")} />
        <Stat
          label="Found it helpful"
          value={percent(totals.helpful, totals.helpful + totals.notHelpful)}
          hint={`${plural(totals.helpful + totals.notHelpful, "answer", "answers")} to “Was this helpful?”`}
          trend={helpfulTrend(range, report)}
        />
        <Stat label="Published articles" value={count(totals.publishedArticles)} hint="Articles readers can find now" />
      </Stats>
      <Card>
        <CardHeader>
          <CardTitle>All articles</CardTitle>
        </CardHeader>
        <CardContent>
          {articles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No published articles yet.</p>
          ) : (
            <table className="w-full text-sm" aria-label="All articles">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="pb-2 font-medium">
                    Article
                  </th>
                  {sortHeading("views", "Views")}
                  {sortHeading("rate", "Found it helpful")}
                  {sortHeading("helpful", "Helpful")}
                  {sortHeading("notHelpful", "Not helpful")}
                </tr>
              </thead>
              <tbody className="divide-y">
                {articles.map((article) => (
                  <tr key={article.slug}>
                    <td className="py-2">
                      <Link href={`/app/${slug}/docs/${article.slug}`} className="font-medium hover:underline">
                        {article.title}
                      </Link>
                      {!article.published && (
                        <Badge variant="outline" className="ml-2">
                          Unpublished
                        </Badge>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {article.collection ?? "In no collection"}
                        {article.helpful + article.notHelpful > 0 && (
                          <span className="md:hidden">
                            {" · "}
                            {percent(article.helpful, article.helpful + article.notHelpful)} helpful ({count(article.helpful)} of{" "}
                            {plural(article.helpful + article.notHelpful, "answer", "answers")})
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="py-2 text-right tabular-nums">{count(article.views)}</td>
                    <td className="py-2 text-right tabular-nums max-md:hidden">{percent(article.helpful, article.helpful + article.notHelpful)}</td>
                    <td className="py-2 text-right tabular-nums max-md:hidden">{count(article.helpful)}</td>
                    <td className="py-2 text-right tabular-nums max-md:hidden">{count(article.notHelpful)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </ReportBody>
  );
}
