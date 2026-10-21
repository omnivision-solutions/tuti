import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { DismissGapButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { docsInsights, INSIGHTS_DAYS } from "@/server/operations/docs-insights";

export const metadata = { title: "Docs insights" };

/** Why a gap's latest question got "I don't know" (none for questions asked before causes were kept). */
const CAUSES: Record<string, string> = {
  no_relevant_section: "No matching article",
  no_valid_citation: "AI found no answer",
  source_unpublished: "Article unpublished",
  off_limits: "Off-limits",
};

const plural =(count: number, one: string, many: string) => `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

function helpfulness(helpful: number, notHelpful: number) {
  const answers = helpful + notHelpful;
  return answers === 0 ? "No answers yet" : `${Math.round((helpful / answers) * 100)}% found it helpful (${helpful} of ${answers})`;
}

/** What readers did in the docs lately: views, which articles helped, what they missed and couldn't find. */
export default async function DocsInsightsPage(props: PageProps<"/app/[project]/docs/insights">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const insights = await docsInsights(membership.project.id);
  const empty = (text: string) => <p className="text-sm text-muted-foreground">{text}</p>;

  return (
    <>
      <BackLink href={`/app/${slug}/docs`}>Docs</BackLink>
      <PageHeader
        title="Insights"
        description={`The last ${INSIGHTS_DAYS} days: ${plural(insights.views, "article view", "article views")}, ${plural(insights.searches.total, "search", "searches")}, ${plural(insights.searches.failed, "failed search", "failed searches")}.`}
      />
      <Card>
        <CardHeader>
          <CardTitle>Gaps</CardTitle>
          <CardDescription>Questions the AI couldn’t answer, or whose answer got a thumbs-down: topics to write about.</CardDescription>
        </CardHeader>
        <CardContent>
          {insights.gaps.length === 0 ? (
            empty("No gaps: every question got an answer.")
          ) : (
            <ItemList>
              {insights.gaps.map((gap) => (
                <ItemRow
                  key={gap.question}
                  wideActions
                  title={gap.question}
                  badges={
                    <>
                      {gap.cause && CAUSES[gap.cause] && <Badge variant="secondary">{CAUSES[gap.cause]}</Badge>}
                      {/* Someone asked for a person: the team's support address has it. */}
                      {gap.escalated > 0 && <Badge variant="soft">Escalated</Badge>}
                    </>
                  }
                  meta={
                    <>
                      {[
                        gap.noAnswer > 0 && `${gap.noAnswer} unanswered`,
                        gap.notHelpful > 0 && `${gap.notHelpful} not helpful`,
                        timeAgo(new Date(gap.lastAsked)),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      {gap.answer && <p className="mt-1 break-words whitespace-pre-line">Answer: {gap.answer}</p>}
                    </>
                  }
                  actions={
                    <>
                      <Link
                        href={`/app/${slug}/docs/new?${new URLSearchParams({ title: gap.question })}`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        Write an article
                      </Link>
                      <DismissGapButton projectSlug={slug} question={gap.question} />
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
                    <Link href={`/app/${slug}/docs/${article.slug}`} className="hover:underline">
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
