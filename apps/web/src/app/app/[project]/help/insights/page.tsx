import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { helpInsights, INSIGHTS_DAYS } from "@/server/operations/help-insights";

export const metadata = { title: "Help center insights" };

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

function helpfulness(helpful: number, notHelpful: number) {
  const answers = helpful + notHelpful;
  return answers === 0 ? "No answers yet" : `${Math.round((helpful / answers) * 100)}% found it helpful (${helpful} of ${answers})`;
}

/** What readers did in the help center lately: views, which articles helped, what they missed and couldn't find. */
export default async function HelpInsightsPage(props: PageProps<"/app/[project]/help/insights">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const insights = await helpInsights(membership.project.id);
  const empty = (text: string) => <p className="text-sm text-muted-foreground">{text}</p>;

  return (
    <>
      <BackLink href={`/app/${slug}/help`}>Help center</BackLink>
      <PageHeader
        title="Insights"
        description={`The last ${INSIGHTS_DAYS} days: ${plural(insights.views, "article view", "article views")}, ${plural(insights.searches.total, "search", "searches")}, ${plural(insights.searches.failed, "failed search", "failed searches")}.`}
      />
      <Card>
        <CardHeader>
          <CardTitle>Top articles</CardTitle>
          <CardDescription>By views, with how many readers answered “Yes” to “Was this helpful?”</CardDescription>
        </CardHeader>
        <CardContent>
          {insights.articles.length === 0 ? (
            empty("No views or answers yet.")
          ) : (
            <ItemList>
              {insights.articles.map((article) => (
                <ItemRow
                  key={article.slug}
                  title={
                    <Link href={`/app/${slug}/help/${article.slug}`} className="hover:underline">
                      {article.title}
                    </Link>
                  }
                  meta={`${plural(article.views, "view", "views")} · ${helpfulness(article.helpful, article.notHelpful)}`}
                />
              ))}
            </ItemList>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What readers missed</CardTitle>
          <CardDescription>The latest comments from readers who answered “No”.</CardDescription>
        </CardHeader>
        <CardContent>
          {insights.comments.length === 0 ? (
            empty("No comments yet.")
          ) : (
            <ItemList>
              {insights.comments.map((comment) => (
                <ItemRow
                  key={`${comment.article.slug}-${comment.at}`}
                  title={<span className="font-normal">{comment.comment}</span>}
                  meta={
                    <>
                      <Link href={`/app/${slug}/help/${comment.article.slug}`} className="hover:underline">
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
      <Card>
        <CardHeader>
          <CardTitle>Failed searches</CardTitle>
          <CardDescription>What readers searched for that matched no article: topics to write about.</CardDescription>
        </CardHeader>
        <CardContent>
          {insights.searches.topFailed.length === 0 ? (
            empty("No failed searches.")
          ) : (
            <ItemList>
              {insights.searches.topFailed.map((search) => (
                <ItemRow
                  key={search.query}
                  title={search.query}
                  actions={<Badge variant="secondary">{plural(search.count, "search", "searches")}</Badge>}
                />
              ))}
            </ItemList>
          )}
        </CardContent>
      </Card>
    </>
  );
}
