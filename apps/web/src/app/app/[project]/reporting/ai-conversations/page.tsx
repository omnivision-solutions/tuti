import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";

import { PastHistoryNotice } from "@/components/inbox/past-history-notice";
import { count, countTrend, DailyChart, percent, plural, ReportBody, ReportHeading, shareTrend, Stat, Stats } from "@/components/reports";
import { SubNav } from "@/components/sub-nav";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";
import { withRange } from "@/lib/report-range";
import { isAdminRole } from "@/lib/roles";
import { AI_CONVERSATION_FILTERS, type AiConversationFilter, aiReport } from "@/server/operations/reports";
import { reportingPage, sampleAiReport } from "@/server/reporting";

export const metadata = { title: "AI conversations · Reporting" };

const SOURCES = { portal: "Portal", widget: "Widget", api: "API" };

/**
 * Reporting → AI support → AI conversations: readers' conversations with the AI that answers from the docs (on the portal, in the widget,
 * through the API). Only those passed to the team reach the inbox; this is every one, each opened to read it.
 */
export default async function ReportingAiConversationsPage(props: PageProps<"/app/[project]/reporting/ai-conversations">) {
  const [{ project: slug }, { show: given, range: rangeGiven }] = await Promise.all([props.params, props.searchParams]);
  const { membership, range, locked, sample, upgrade } = await reportingPage(slug, rangeGiven);
  const show = AI_CONVERSATION_FILTERS.find((filter) => filter === given) as AiConversationFilter | undefined;
  const report = sample ? sampleAiReport(range) : await aiReport(membership.project.id, range, show);
  const { plan } = membership.project;
  const { totals, before } = report;
  const conversations = report.daily.handled.map((handled, i) => handled + report.daily.escalated[i]!);
  const base = `/app/${slug}/reporting/ai-conversations`;
  return (
    <ReportBody upgrade={upgrade}>
      <ReportHeading section="AI support" title="AI conversations" range={range.key} locked={locked} />
      <Stats>
        <Stat label="Conversations" value={count(totals.conversations)} hint="A question and its follow-ups" trend={countTrend(range, conversations, before.conversations, "up")} />
        <Stat label="Answered" value={percent(totals.answered, totals.conversations)} hint="Every question answered from the docs"
          trend={shareTrend(range, report.daily.answered, conversations, { part: before.answered, whole: before.conversations }, "up")}
        />
        <Stat label="Passed to your team" value={count(totals.escalated)} hint="To your inbox or support address" href={withRange(`${base}?show=escalated`, range.key)} trend={countTrend(range, report.daily.escalated, before.escalated, "down")} />
        <Stat label="Thumbs up" value={count(totals.helpful)} hint={`And ${plural(totals.notHelpful, "thumbs down", "thumbs down")}`} trend={countTrend(range, report.daily.helpful, before.helpful, "up")} />
      </Stats>
      <DailyChart
        title="Conversations"
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
          current={withRange(show ? `${base}?show=${show}` : base, range.key)}
          items={[
            { title: "All", href: withRange(base, range.key) },
            { title: "Passed to your team", href: withRange(`${base}?show=escalated`, range.key) },
            { title: "With a question unanswered", href: withRange(`${base}?show=unanswered`, range.key) },
          ]}
        />
        {report.pastHistory > 0 && <PastHistoryNotice what="AI conversations" plan={plan} projectSlug={slug} admin={isAdminRole(membership.role)} />}
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
    </ReportBody>
  );
}
