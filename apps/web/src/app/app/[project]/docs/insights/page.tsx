import Link from "next/link";
import { notFound } from "next/navigation";

import { DismissGapButton } from "@/components/docs";
import { DocsSections } from "@/components/docs-sections";
import { EmptyState } from "@/components/empty-state";
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
  // Nothing read, searched, asked or answered lately: one empty state, not a card of "nothing yet" each.
  const quiet = insights.views === 0 && insights.searches.total === 0 && insights.gaps.length === 0 && insights.articles.length === 0 && insights.comments.length === 0;
  // A failed search that's also a gap (grouped as Gaps groups them) is counted on the gap's row, not listed again.
  const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  const searchesOf = new Map(insights.searches.topFailed.map((search) => [key(search.query), search.count]));
  const searches = insights.searches.topFailed.filter((search) => !insights.gaps.some((gap) => key(gap.question) === key(search.query)));
  /** A gap's buttons: an article with `topic` as its title, or Dismiss. */
  const gapActions = (topic: string) => (
    <>
      <Link
        href={`/app/${slug}/docs/new?${new URLSearchParams({ title: topic })}`}
        aria-label={`Write an article about “${topic}”`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Write an article
      </Link>
      <DismissGapButton projectSlug={slug} question={topic} />
    </>
  );

  return (
    <>
      <PageHeader title="Docs" />
      <DocsSections projectSlug={slug} current="insights" />
      {quiet ? (
        <EmptyState
          title="No reader activity yet"
          description={`As readers open, search and ask about your docs, the last ${INSIGHTS_DAYS} days show here: the top articles, what helped, and what readers couldn't find.`}
        />
      ) : (
        <>
          {/* Under the tabs: it sums up this tab's numbers, not the docs. */}
          <p className="text-sm text-muted-foreground">
            The last {INSIGHTS_DAYS} days: {plural(insights.views, "article view", "article views")}, {plural(insights.searches.total, "search", "searches")},{" "}
            {plural(insights.searches.failed, "failed search", "failed searches")}.
          </p>
          <Card>
            <CardHeader>
              <CardTitle>Gaps</CardTitle>
              <CardDescription>
                Questions the AI couldn’t answer or whose answer got a thumbs-down, and searches that matched no article: topics to write about.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {insights.gaps.length === 0 && searches.length === 0 ? (
                empty("No gaps: readers found what they looked for.")
              ) : (
                <ItemList aria-label="Gaps">
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
                            searchesOf.has(key(gap.question)) && plural(searchesOf.get(key(gap.question))!, "failed search", "failed searches"),
                            timeAgo(new Date(gap.lastAsked)),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          {gap.answer && <p className="mt-1 break-words whitespace-pre-line">Answer: {gap.answer}</p>}
                        </>
                      }
                      actions={gapActions(gap.question)}
                    />
                  ))}
                  {searches.map((search) => (
                    <ItemRow
                      key={search.query}
                      wideActions
                      title={search.query}
                      meta={plural(search.count, "failed search", "failed searches")}
                      actions={gapActions(search.query)}
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
        </>
      )}
    </>
  );
}
