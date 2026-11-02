import { prisma } from "@tuti/db";
import { emailedAbout } from "@tuti/jobs";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { RichText } from "@tuti/content/react";

import { ArticleDiff } from "@/components/article-diff";
import { AutopilotReview } from "@/components/autopilot-review";
import { PageHeader } from "@/components/page-header";
import { PlanNotice } from "@/components/plan-notice";
import { PullRequestChip } from "@/components/pull-request-chip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { afterButton, plural, UPDATE_ORDER } from "@/lib/autopilot-words";
import { displayDoc } from "@/server/content";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";
import { targetReview } from "@/server/operations/code-changes";

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

const param = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

/**
 * A post's or an article's review in Autopilot (`type`: feedback or articles): the pull requests with updates waiting
 * on it as chips, then its updates from each of them to approve, edit or dismiss, and those decided, to undo.
 */
export async function AutopilotTargetPage({
  slug,
  type,
  id,
  searchParams,
}: {
  slug: string;
  type: "feedback" | "articles";
  id: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const membership = await getMembership(slug);
  const review = membership && (await targetReview(membership.project.id, type, id));
  if (!review) {
    notFound();
  }
  // On a plan without Autopilot it's kept, but can't be analysed again (codeChanges.analyse refuses).
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true } });
  const included = planIncludes(plan, "codeChanges");
  const updates = [...review.actions].sort((a, b) => UPDATE_ORDER.indexOf(a.kind) - UPDATE_ORDER.indexOf(b.kind));
  // Previewed while waiting, or going out by itself (seen during the hold).
  const docs = updates.filter((action) => (action.kind === "article_edit" || action.kind === "new_article") && (action.status === "pending" || action.status === "scheduled"));
  const previews = Object.fromEntries(await docsPreviews(docs.map((action) => action.id)));
  // `?select=<ids>` (an email's Edit, or its button opened by someone else) ticks those; else the likely ones.
  const select = param(searchParams.select);
  const likely = updates.filter((action) => action.applyLikely).map((action) => action.id);
  const ticked = select === null || select === "likely" ? likely : select.split(",").map((value) => value.trim()).filter(Boolean);
  // Back from Approve in Autopilot's email (the act page): what it did, or who did it first, and when.
  const done = afterButton(updates, param(searchParams.done), param(searchParams.button), param(searchParams.update));
  const emailed = [...new Set((await Promise.all(review.changes.map((change) => emailedAbout(change.id)))).flat())];
  const { post, article } = review;

  return (
    <>
      <PageHeader
        back={{ href: `/app/${slug}/autopilot`, label: "Autopilot" }}
        title={review.title}
        meta={
          post
            ? `#${post.number} · ${plural(post.votes, "vote")}`
            : article
              ? (article.collection ?? "No collection")
              : "A new article"
        }
      />
      <div className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Pull requests">
        {review.pullRequests.map((pr) => (
          <PullRequestChip key={pr.id} projectSlug={slug} pr={pr} />
        ))}
      </div>
      {done && (
        <Alert>
          <AlertDescription>{done}</AlertDescription>
        </Alert>
      )}
      {!included && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin={membership!.role !== "MEMBER"}>
          It&apos;s kept, and can be analysed once the plan is back.
        </PlanNotice>
      )}
      <AutopilotReview
        projectSlug={slug}
        id={`${type}/${id}`}
        changes={review.changes}
        updates={updates}
        ticked={ticked}
        fromEmail={!select ? null : select === "likely" ? "likely" : "named"}
        emailed={emailed}
        previews={previews}
        canAnalyse={included}
      />
    </>
  );
}
