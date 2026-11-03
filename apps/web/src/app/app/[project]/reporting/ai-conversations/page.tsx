import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { count, DailyChart, percent, plural, ReportHeading, Stat, Stats } from "@/components/reports";
import { SubNav } from "@/components/sub-nav";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { AI_CONVERSATION_FILTERS, type AiConversationFilter, aiReport, INSIGHTS_DAYS } from "@/server/operations/reports";

export const metadata = { title: "AI conversations · Reporting" };

const SOURCES = { portal: "Portal", widget: "Widget", api: "API" };

/**
 * Reporting → AI support → AI conversations: readers' conversations with the AI that answers from the docs (on the portal, in the widget,
 * through the API). Only those passed to the team reach the inbox; this is every one, each opened to read it.
 */
export default async function ReportingAiConversationsPage(props: PageProps<"/app/[project]/reporting/ai-conversations">) {
  const [{ project: slug }, { show: given }] = await Promise.all([props.params, props.searchParams]);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const show = AI_CONVERSATION_FILTERS.find((filter) => filter === given) as AiConversationFilter | undefined;
  const report = await aiReport(membership.project.id, show);
  const { totals } = report;
  const base = `/app/${slug}/reporting/ai-conversations`;
  return (
    <>
      <ReportHeading section="AI support" title="AI conversations" days={INSIGHTS_DAYS} />
      <Stats>
        <Stat label="Conversations" value={count(totals.conversations)} hint="A question and its follow-ups" />
        <Stat label="Answered" value={percent(totals.answered, totals.conversations)} hint="Every question answered from the docs" />
        <Stat label="Passed to your team" value={count(totals.escalated)} hint="Readers who asked for a person: to your inbox or support address" href={`${base}?show=escalated`} />
        <Stat label="Thumbs up" value={count(totals.helpful)} hint={`And ${plural(totals.notHelpful, "thumbs down", "thumbs down")}`} />
      </Stats>
      <DailyChart
        title="Conversations by day"
        days={report.days}
        series={[
          { label: "Handled by AI", values: report.daily.handled },
          { label: "Passed to your team", values: report.daily.escalated },
        ]}
      />
      <section aria-labelledby="ai-history" className="flex flex-col gap-3">
        <h3 id="ai-history" className="font-heading text-base font-medium">
          Latest conversations
        </h3>
        <SubNav
          label="Show conversations"
          scroll={false}
          current={show ? `${base}?show=${show}` : base}
          items={[
            { title: "All", href: base },
            { title: "Passed to your team", href: `${base}?show=escalated` },
            { title: "With a question unanswered", href: `${base}?show=unanswered` },
          ]}
        />
        {report.conversations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No conversations here yet.</p>
        ) : (
          <ul aria-label="AI conversations" className="flex flex-col divide-y rounded-xl border bg-card">
            {report.conversations.map((conversation) => (
              <li key={conversation.id}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-col gap-1 px-4 py-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-4 [&::-webkit-details-marker]:hidden">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-medium">{conversation.turns[0]?.question}</span>
                      <span className="text-xs text-muted-foreground">
                        {[SOURCES[conversation.source], conversation.asker, plural(conversation.turns.length, "question", "questions"), timeAgo(new Date(conversation.lastAt))]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">
                        {conversation.answered === conversation.turns.length
                          ? "Answered"
                          : conversation.answered === 0
                            ? "Not answered"
                            : "Partly answered"}
                      </Badge>
                      {conversation.escalated && <Badge variant="soft">Passed to your team</Badge>}
                      {conversation.helpful > 0 && (
                        <Badge variant="outline">
                          <ThumbsUpIcon aria-hidden />
                          {conversation.helpful}
                          <span className="sr-only">thumbs up</span>
                        </Badge>
                      )}
                      {conversation.notHelpful > 0 && (
                        <Badge variant="outline">
                          <ThumbsDownIcon aria-hidden />
                          {conversation.notHelpful}
                          <span className="sr-only">thumbs down</span>
                        </Badge>
                      )}
                    </div>
                  </summary>
                  <ol className="flex flex-col gap-3 border-t bg-muted/30 px-4 py-3 text-sm">
                    {conversation.turns.map((turn, i) => (
                      <li key={i} className="flex flex-col gap-1">
                        <p className="font-medium">{turn.question}</p>
                        <p className="whitespace-pre-line text-muted-foreground">
                          {turn.status === "answered" ? turn.answer : turn.status === "no_answer" ? "“I don't know”: no answer in the docs." : "No answer: the AI failed."}
                        </p>
                        {(turn.helpful !== null || turn.escalated) && (
                          <p className="text-xs text-muted-foreground">
                            {[turn.helpful === true && "Thumbs up", turn.helpful === false && "Thumbs down", turn.escalated && "Passed to your team"]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
