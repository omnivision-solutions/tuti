import Link from "next/link";
import { notFound } from "next/navigation";

import { count, percent, plural, ReportHeading, Stat, Stats } from "@/components/reports";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getMembership } from "@/server/membership";
import { docsReport, INSIGHTS_DAYS } from "@/server/operations/reports";

export const metadata = { title: "Articles · Reporting" };

/** Reporting → Docs → Articles: every published article (and any other read lately) with its views and answers to "Was this helpful?". */
export default async function ReportingArticlesPage(props: PageProps<"/app/[project]/reporting/articles">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const { totals, articles } = await docsReport(membership.project.id);
  return (
    <>
      <ReportHeading section="Docs" title="Articles">
        Each article&apos;s views and readers&apos; answers to “Was this helpful?” in the last {INSIGHTS_DAYS} days, most read first.
      </ReportHeading>
      <Stats>
        <Stat label="Article views" value={count(totals.views)} hint="Articles opened on the portal and in the widget" />
        <Stat
          label="Found it helpful"
          value={percent(totals.helpful, totals.helpful + totals.notHelpful)}
          hint={`${plural(totals.helpful + totals.notHelpful, "answer", "answers")} to “Was this helpful?”`}
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
                  <th className="pb-2 font-medium">Article</th>
                  <th className="pb-2 text-right font-medium">Views</th>
                  <th className="pb-2 text-right font-medium">Helpful</th>
                  <th className="pb-2 text-right font-medium">Not helpful</th>
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
                      <p className="text-xs text-muted-foreground">{article.collection ?? "In no collection"}</p>
                    </td>
                    <td className="py-2 text-right tabular-nums">{count(article.views)}</td>
                    <td className="py-2 text-right tabular-nums">{count(article.helpful)}</td>
                    <td className="py-2 text-right tabular-nums">{count(article.notHelpful)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
