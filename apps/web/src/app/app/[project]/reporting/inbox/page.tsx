
import { count, DailyChart, duration, ReportHeading, Stat, Stats } from "@/components/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { inboxReport } from "@/server/operations/reports";
import { reportingPage, sampleInboxReport } from "@/server/reporting";

export const metadata = { title: "Inbox · Reporting" };

const ORIGINS = { widget: "Messages in the widget", email: "Email", escalation: "“Ask a person” after an AI answer", api: "The API" } as const;

/** Reporting → Inbox → Conversations: new conversations, where they began, how soon the team replied, and who replied. */
export default async function ReportingInboxPage(props: PageProps<"/app/[project]/reporting/inbox">) {
  const [{ project: slug }, { range: given }] = await Promise.all([props.params, props.searchParams]);
  const { membership, range, locked, sample } = await reportingPage(slug, given);
  const report = sample ? sampleInboxReport(range) : await inboxReport(membership.project.id, range);
  const { totals } = report;
  return (
    <>
      <ReportHeading section="Inbox" title="Conversations" range={range.key} locked={locked} />
      <Stats>
        <Stat label="New conversations" value={count(totals.conversations)} hint="Spam left out" />
        <Stat label="From AI answers" value={count(totals.fromAi)} hint="Readers who asked for a person" />
        <Stat
          label="First reply"
          value={totals.medianFirstReply === null ? "–" : duration(totals.medianFirstReply)}
          hint={`The median, of ${count(totals.replied)} replied to`}
        />
        <Stat label="Open now" value={count(totals.openNow)} hint="Waiting for your team's reply" href={`/app/${slug}/inbox`} />
      </Stats>
      <DailyChart title="New conversations" days={report.days} series={[{ label: "New conversations", values: report.daily.created }]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Where they began</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm" aria-label="Where they began">
              <tbody className="divide-y">
                {(Object.keys(ORIGINS) as (keyof typeof ORIGINS)[]).map((origin) => (
                  <tr key={origin}>
                    <td className="py-2">{ORIGINS[origin]}</td>
                    <td className="py-2 text-right tabular-nums">{count(report.origins[origin])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Replies by teammate</CardTitle>
          </CardHeader>
          <CardContent>
            {report.teammates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No replies yet.</p>
            ) : (
              <table className="w-full text-sm" aria-label="Replies by teammate">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Teammate</th>
                    <th className="pb-2 text-right font-medium">Replies</th>
                    {/* On phones, who and their replies; the rest from tablet width up. */}
                    <th className="pb-2 text-right font-medium max-md:hidden">Conversations</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.teammates.map((teammate) => (
                    <tr key={teammate.id ?? "gone"}>
                      <td className="py-2">{teammate.name ?? "A former teammate"}</td>
                      <td className="py-2 text-right tabular-nums">{count(teammate.replies)}</td>
                      <td className="py-2 text-right tabular-nums max-md:hidden">{count(teammate.conversations)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
