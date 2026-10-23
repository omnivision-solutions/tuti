import { ExternalLinkIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { AnalyseCodeChangeButton, ApplyLikelyButton, PostProposal } from "@/components/code-changes";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { codeChangeDetail } from "@/server/operations/code-changes";

/** A code change: the merged pull request, what changed for users, and the proposals to review. */
export default async function CodeChangePage(props: PageProps<"/app/[project]/code-changes/[id]">) {
  const { project: slug, id } = await props.params;
  const membership = await getMembership(slug);
  const change = membership && (await codeChangeDetail(membership.project.id, id));
  if (!change) {
    notFound();
  }
  const mergedAt = new Date(change.mergedAt);
  const feedback = change.actions.filter((action) => action.post);
  const likely = feedback.filter((action) => action.status === "pending" && action.confidence === "likely").length;

  return (
    <>
      <BackLink href={`/app/${slug}/code-changes`}>Code changes</BackLink>
      <PageHeader
        title={change.title}
        description={
          <>
            <a href={change.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
              {change.repo}#{change.number}
              <ExternalLinkIcon className="size-3.5" />
            </a>{" "}
            by @{change.author}, <span title={formatDate(mergedAt)}>merged {timeAgo(mergedAt)}</span>
          </>
        }
      />
      {change.state === "analysing" && (
        <Alert>
          <AlertDescription>Tuti is analysing this pull request. Proposals show here when it&apos;s done.</AlertDescription>
        </Alert>
      )}
      {(change.state === "failed" || change.state === "nothing_to_do") && (
        <Alert variant={change.state === "failed" ? "destructive" : "default"}>
          <AlertDescription className="flex flex-col items-start gap-2">
            {change.state === "failed" ? `The analysis stopped. ${change.reason}` : `Nothing to do. ${change.reason}`}
            <AnalyseCodeChangeButton projectSlug={slug} codeChangeId={change.id} label={change.state === "failed" ? "Analyse again" : "Analyse anyway"} />
          </AlertDescription>
        </Alert>
      )}
      {change.summary && (
        <Card>
          <CardHeader>
            <CardTitle>What changed for users</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <p>{change.summary}</p>
            {change.why && (
              <div className="flex flex-col gap-1">
                <h3 className="font-medium">Why Tuti proposes this</h3>
                <p className="text-muted-foreground">{change.why}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {feedback.length > 0 && (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle>Review changes</CardTitle>
              <CardDescription>Nothing changes for your users until you apply a proposal.</CardDescription>
            </div>
            {likely > 0 && <ApplyLikelyButton projectSlug={slug} codeChangeId={change.id} count={likely} />}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <h3 id="feedback-proposals" className="text-sm font-semibold">
              Feedback
            </h3>
            <ul className="flex flex-col divide-y" aria-labelledby="feedback-proposals">
              {feedback.map((action) => (
                <PostProposal key={action.id} projectSlug={slug} action={action} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
