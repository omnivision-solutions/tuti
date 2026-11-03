import Link from "next/link";
import { notFound } from "next/navigation";

import { DismissGapButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { ReportHeading } from "@/components/reports";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { docsGaps, insightsSince } from "@/server/operations/docs-insights";
import { INSIGHTS_DAYS } from "@/server/operations/reports";

export const metadata = { title: "Unanswered questions · Reporting" };

/** Why a question's latest "I don't know" happened (none for questions asked before causes were kept). */
const CAUSES: Record<string, string> = {
  no_relevant_section: "No matching article",
  no_valid_citation: "AI found no answer",
  source_unpublished: "Article unpublished",
  off_limits: "Off-limits",
};

/** Reporting → AI support → Unanswered questions: what the AI couldn't answer or answered unhelpfully, grouped: topics to write about. */
export default async function ReportingUnansweredPage(props: PageProps<"/app/[project]/reporting/unanswered">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const gaps = await docsGaps(membership.project.id, insightsSince());
  return (
    <>
      <ReportHeading section="AI support" title="Unanswered questions">
        Questions the AI couldn&apos;t answer from your docs, or whose answer got a thumbs down, in the last {INSIGHTS_DAYS} days: topics to
        write about. Most asked first.
      </ReportHeading>
      <Card>
        <CardContent>
          {gaps.length === 0 ? (
            <p className="text-sm text-muted-foreground">None: the AI answered every question it was asked.</p>
          ) : (
            <ItemList aria-label="Unanswered questions">
              {gaps.map((gap) => (
                <ItemRow
                  key={gap.question}
                  wideActions
                  title={gap.question}
                  badges={
                    <>
                      {gap.cause && CAUSES[gap.cause] && <Badge variant="secondary">{CAUSES[gap.cause]}</Badge>}
                      {/* Someone asked for a person: the team has it. */}
                      {gap.escalated > 0 && <Badge variant="soft">Passed to your team</Badge>}
                    </>
                  }
                  meta={
                    <>
                      {[gap.noAnswer > 0 && `${gap.noAnswer} unanswered`, gap.notHelpful > 0 && `${gap.notHelpful} not helpful`, timeAgo(new Date(gap.lastAsked))]
                        .filter(Boolean)
                        .join(" · ")}
                      {gap.answer && <p className="mt-1 break-words whitespace-pre-line">Answer: {gap.answer}</p>}
                    </>
                  }
                  actions={
                    <>
                      <Link
                        href={`/app/${slug}/docs/new?${new URLSearchParams({ title: gap.question })}`}
                        aria-label={`Write an article about “${gap.question}”`}
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
    </>
  );
}
