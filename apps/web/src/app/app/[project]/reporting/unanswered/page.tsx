import Link from "next/link";
import { notFound } from "next/navigation";

import { DismissGapButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { ReportHeading } from "@/components/reports";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { reportRange } from "@/lib/report-range";
import { getMembership } from "@/server/membership";
import { docsGaps } from "@/server/operations/docs-insights";

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
  const [{ project: slug }, { range: given }] = await Promise.all([props.params, props.searchParams]);
  const range = reportRange(typeof given === "string" ? given : undefined);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const gaps = await docsGaps(membership.project.id, range.since, range.until);
  return (
    <>
      <ReportHeading section="AI support" title="Unanswered questions" range={range.key} />
      <Card>
        <CardHeader>
          <CardTitle>Topics to write about</CardTitle>
          <CardDescription>What the AI couldn&apos;t answer, or answered unhelpfully, most asked first.</CardDescription>
        </CardHeader>
        <CardContent>
          {gaps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unanswered questions in this range (dismissed ones are hidden).</p>
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
