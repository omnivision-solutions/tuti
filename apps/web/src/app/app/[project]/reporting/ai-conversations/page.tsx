import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import Link from "next/link";

import { HashHeading } from "@/components/hash-heading";
import { PastHistoryNotice } from "@/components/inbox/past-history-notice";
import { count, countTrend, DailyChart, percent, plural, ReportBody, ReportHeading, shareTrend, Stat, Stats } from "@/components/reports";
import { SubNav } from "@/components/sub-nav";
import { Badge } from "@/components/ui/badge";
import { PageNav } from "@/components/page-nav";
import { timeAgo } from "@/lib/format";
import { withRange } from "@/lib/report-range";
import { isAdminRole } from "@/lib/roles";
import { AI_CONVERSATION_FILTERS, type AiConversationFilter, aiReport } from "@/server/operations/reports";
import { reportingPage, sampleAiReport } from "@/server/reporting";

export const metadata = { title: "AI conversations · Reporting" };

const SOURCES = { portal: "Portal", widget: "Widget", api: "API" };
/** Conversations a page lists: the same few questions come up again and again, and one long list buried what came after. */
const PER_PAGE = 20;

/**
 * Reporting → AI support → AI conversations: readers' conversations with the AI that answers from the docs (on the portal, in the widget,
 * through the API). Only those passed to the team reach the inbox; this is every one, each opened to read it.
 */
export default async function ReportingAiConversationsPage(props: PageProps<"/app/[project]/reporting/ai-conversations">) {
  const [{ project: slug }, { show: given, range: rangeGiven, page: pageGiven }] = await Promise.all([props.params, props.searchParams]);
  const { membership, range, locked, sample, upgrade } = await reportingPage(slug, rangeGiven);
  const show = AI_CONVERSATION_FILTERS.find((filter) => filter === given) as AiConversationFilter | undefined;
  // Bounded only so its offset stays a whole number: 2 million conversations in a range, more than a year of any help center's.
  const page = Math.max(1, Math.min(100_000, Math.floor(Number(pageGiven)) || 1));
  const report = sample ? sampleAiReport(range) : await aiReport(membership.project.id, range, show, { page, perPage: PER_PAGE });
  const { plan } = membership.project;
  const { totals, before } = report;
  const conversations = report.daily.handled.map((handled, i) => handled + report.daily.escalated[i]!);
  const base = `/app/${slug}/reporting/ai-conversations`;
  const pageHref = (to: number) => {
    const query = new URLSearchParams({ ...(show && { show }), ...(to > 1 && { page: String(to) }) }).toString();
    return withRange(query ? `${base}?${query}` : base, range.key);
  };
  return (
    <ReportBody upgrade={upgrade}>
      <ReportHeading section="AI support" title="AI conversations" range={range} locked={locked} />
      <Stats compared={range}>
        <Stat label="Conversations" value={count(totals.conversations)} hint="A question and its follow-ups" trend={countTrend(range, conversations, before?.conversations ?? null, "up")} />
        <Stat label="Answered" value={percent(totals.answered, totals.conversations)} hint="Every question answered from the docs"
          trend={shareTrend(range, report.daily.answered, conversations, before && { part: before.answered, whole: before.conversations }, "up")}
        />
        <Stat label="Passed to your team" value={count(totals.escalated)} hint="To your inbox" href={withRange(`${base}?show=escalated`, range.key)} trend={countTrend(range, report.daily.escalated, before?.escalated ?? null, "down")} />
        <Stat
          label="Rated helpful"
          value={percent(totals.helpful, totals.rated)}
          hint={`Thumbs up, of ${plural(totals.rated, "conversation", "conversations")} rated`}
          trend={shareTrend(range, report.daily.helpful, report.daily.rated, before && { part: before.helpful, whole: before.rated }, "up")}
        />
      </Stats>
      <DailyChart
        title="Conversations"
        days={report.days} today={range.today}
        series={[
          { label: "Handled by AI", values: report.daily.handled },
          { label: "Passed to your team", values: report.daily.escalated },
        ]}
      />
      <section aria-labelledby="ai-history" className="flex flex-col gap-3">
        {/* Newer and Older come back here (under the top bar), focus too, so the new page is read from its start. */}
        <HashHeading key={page} id="ai-history" className="scroll-mt-20 font-heading text-base font-medium outline-none">
          Latest conversations
        </HashHeading>
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
                            {[turn.helpful === true && "Thumbs up", turn.helpful === false && "Thumbs down"].filter(Boolean).join(" · ")}
                            {turn.helpful !== null && turn.escalated && " · "}
                            {/* Where the team has it, once it started a conversation in the Inbox. */}
                            {turn.conversation ? (
                              <Link href={`/app/${slug}/inbox/${turn.conversation}`} className="text-foreground underline underline-offset-4 hover:text-primary">
                                Passed to your team: conversation #{turn.conversation}
                              </Link>
                            ) : (
                              turn.escalated && "Passed to your team"
                            )}
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
        {/* Also on a page past the last (an old link, fewer since): Newer goes to the last. */}
        {(report.listed > PER_PAGE || page > 1) && (
          <PageNav
            back={page > 1 ? { href: `${pageHref(Math.min(page - 1, Math.max(1, Math.ceil(report.listed / PER_PAGE))))}#ai-history`, label: "Newer" } : null}
            on={page * PER_PAGE < report.listed ? { href: `${pageHref(page + 1)}#ai-history`, label: "Older" } : null}
          >
            {report.conversations.length > 0 &&
              `${count((page - 1) * PER_PAGE + 1)}–${count((page - 1) * PER_PAGE + report.conversations.length)} of ${count(report.listed)}`}
          </PageNav>
        )}
      </section>
    </ReportBody>
  );
}
