import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { ExternalLinkIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { RichText } from "@tuti/content/react";

import { ArticleDiff } from "@/components/article-diff";
import { AnalyseCodeChangeButton, ApplyLikelyButton, ChangelogProposal, DocsProposal, PostProposal } from "@/components/code-changes";
import { PageHeader } from "@/components/page-header";
import { PlanNotice } from "@/components/plan-notice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, timeAgo } from "@/lib/format";
import { displayDoc } from "@/server/content";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";
import { codeChangeDetail } from "@/server/operations/code-changes";

/**
 * Pending docs proposals (`ids`) formatted as readers see them, by id: an edit's changed blocks (with
 * one unchanged block either side) against the article as it is (a pending edit is out of date once
 * the article changes, so that's what it was written from), and a new article's draft.
 */
async function docsPreviews(ids: string[]) {
  const actions = await prisma.codeChangeAction.findMany({
    where: { id: { in: ids } },
    select: { id: true, kind: true, payload: true, article: { select: { title: true, body: true, content: true, collection: { select: { name: true } } } } },
  });
  const previews = new Map<string, React.ReactNode>();
  for (const action of actions) {
    const payload = (action.payload ?? {}) as { content?: unknown; body?: string };
    const proposed = { content: payload.content ?? null, body: payload.body ?? "" };
    if (action.kind === "ARTICLE_EDIT" && action.article) {
      previews.set(
        action.id,
        <ArticleDiff before={action.article} after={{ ...action.article, ...proposed }} same="No changes: it's the same as the article." around={1} />,
      );
    } else if (action.kind === "NEW_ARTICLE") {
      const doc = displayDoc(proposed);
      previews.set(action.id, <RichText doc={doc} mediaUrls={await mediaUrls(doc)} className="rich-text" />);
    }
  }
  return previews;
}

/** A shipped change in Autopilot: the merged pull request, what changed for users, and its updates to review. */
export default async function CodeChangePage(props: PageProps<"/app/[project]/autopilot/[id]">) {
  const { project: slug, id } = await props.params;
  const membership = await getMembership(slug);
  const change = membership && (await codeChangeDetail(membership.project.id, id));
  if (!change) {
    notFound();
  }
  const mergedAt = new Date(change.mergedAt);
  // On a plan without code changes it's kept, but can't be analysed again (codeChanges.analyse refuses).
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true } });
  const included = planIncludes(plan, "codeChanges");
  const feedback = change.actions.filter((action) => action.post);
  // Article edits first, then new articles.
  const docs = change.actions
    .filter((action) => action.kind === "article_edit" || action.kind === "new_article")
    .sort((a, b) => Number(a.kind === "new_article") - Number(b.kind === "new_article"));
  const line = change.actions.find((action) => action.kind === "changelog_line");
  const previews = await docsPreviews(docs.filter((action) => action.status === "pending").map((action) => action.id));
  const likely = [...feedback, ...(line ? [line] : [])].filter((action) => action.applyLikely).length;

  return (
    <>
      <PageHeader
        back={{ href: `/app/${slug}/autopilot`, label: "Autopilot" }}
        title={change.title}
        meta={
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
          <AlertDescription>Autopilot is reading this pull request. Its updates show here when it&apos;s done.</AlertDescription>
        </Alert>
      )}
      {!included && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin={membership!.role !== "MEMBER"}>
          It&apos;s kept, and can be analysed once the plan is back.
        </PlanNotice>
      )}
      {change.state === "paused" && (
        <Alert>
          <AlertDescription className="flex flex-col items-start gap-2">
            {included ? `Paused: ${change.reason} It's analysed when you resume it.` : `Paused: ${change.reason}`}
            {included && <AnalyseCodeChangeButton projectSlug={slug} codeChangeId={change.id} label="Resume" />}
          </AlertDescription>
        </Alert>
      )}
      {(change.state === "failed" || change.state === "nothing_to_do") && (
        <Alert variant={change.state === "failed" ? "destructive" : "default"}>
          <AlertDescription className="flex flex-col items-start gap-2">
            {change.state === "failed" ? `The analysis stopped. ${change.reason}` : `Nothing to do. ${change.reason}`}
            {included && (
              <AnalyseCodeChangeButton projectSlug={slug} codeChangeId={change.id} label={change.state === "failed" ? "Analyse again" : "Analyse anyway"} />
            )}
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
                <h3 className="font-medium">Why Autopilot suggests this</h3>
                <p className="text-muted-foreground">{change.why}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {(feedback.length > 0 || docs.length > 0 || line) && (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle>Updates</CardTitle>
              <CardDescription>Nothing changes for your users until you approve an update.</CardDescription>
            </div>
            {likely > 0 && <ApplyLikelyButton projectSlug={slug} codeChangeId={change.id} count={likely} />}
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {feedback.length > 0 && (
              <section className="flex flex-col gap-3">
                <h3 id="feedback-proposals" className="text-sm font-semibold">
                  Requests
                </h3>
                <ul className="flex flex-col divide-y" aria-labelledby="feedback-proposals">
                  {feedback.map((action) => (
                    <PostProposal key={action.id} projectSlug={slug} action={action} />
                  ))}
                </ul>
              </section>
            )}
            {line && (
              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">Changelog line</h3>
                <ChangelogProposal projectSlug={slug} action={line} entry={change.changelog} />
              </section>
            )}
            {docs.length > 0 && (
              <section className="flex flex-col gap-3">
                <h3 id="docs-proposals" className="text-sm font-semibold">
                  Docs
                </h3>
                <ul className="flex flex-col divide-y" aria-labelledby="docs-proposals">
                  {docs.map((action) => (
                    <DocsProposal key={action.id} projectSlug={slug} codeChangeId={change.id} action={action} canAnalyse={included} preview={previews.get(action.id)} />
                  ))}
                </ul>
              </section>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
