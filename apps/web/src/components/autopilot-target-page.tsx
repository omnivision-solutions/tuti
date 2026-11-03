import type { JSONContent } from "@tiptap/core";
import { prisma } from "@tuti/db";
import { emailedAbout } from "@tuti/jobs";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { diffBlocks } from "@tuti/content";
import { RichText } from "@tuti/content/react";

import { ArticleChangesView, ArticlePartChip, ArticleReview } from "@/components/autopilot-article-review";
import { AutopilotReview } from "@/components/autopilot-review";
import { PageHeader } from "@/components/page-header";
import { PlanNotice } from "@/components/plan-notice";
import { PullRequestChip, PullRequestChips } from "@/components/pull-request-chip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { afterButton, plural, UPDATE_ORDER, withPostUpdate } from "@/lib/autopilot-words";
import { displayDoc } from "@/server/content";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";
import { type TargetReview, targetReview } from "@/server/operations/code-changes";

type Doc = ReturnType<typeof displayDoc>;
const EMPTY: Doc = { type: "doc", content: [] };

/**
 * An article's review as one view of the whole article, as readers see it: its published version against its
 * unpublished changes (a new article's draft, or a draft not published yet: all of it added), each run of changed
 * blocks a change to step to (`data-change`), and the new text alone.
 */
async function articleViews(articleId: string | null, review: TargetReview) {
  const article = articleId
    ? await prisma.article.findUnique({ where: { id: articleId }, select: { title: true, body: true, content: true, publishedAt: true, changes: { select: { body: true, content: true } } } })
    : null;
  const draft = review.actions.find((action) => action.kind === "new_article" && action.status !== "applied");
  const payload = draft && !article ? ((await prisma.codeChangeAction.findUnique({ where: { id: draft.id }, select: { payload: true } }))?.payload as { content?: unknown; body?: string } | null) : null;
  const before = article?.publishedAt ? displayDoc(article) : EMPTY;
  const after = article ? displayDoc(article.changes ?? article) : displayDoc({ content: payload?.content ?? null, body: payload?.body ?? "" });
  const media = await mediaUrls(before, after);
  const text = (doc: JSONContent) => <RichText doc={doc} mediaUrls={media} className="rich-text article-text" />;

  // Runs of changed blocks, each one change.
  const runs: { changed: boolean; blocks: ReturnType<typeof diffBlocks> }[] = [];
  for (const block of diffBlocks(before, after)) {
    const changed = block.kind !== "same";
    if (runs.at(-1)?.changed === changed) {
      runs.at(-1)!.blocks.push(block);
    } else {
      runs.push({ changed, blocks: [block] });
    }
  }
  let count = 0;
  const changes = (
    <div className="flex flex-col gap-3 break-words">
      {runs.map((run, i) =>
        run.changed ? (
          <div key={i} data-change={count++} className="flex scroll-mt-32 flex-col gap-1 rounded-md data-current:ring-2 data-current:ring-ring data-current:ring-offset-2 data-current:ring-offset-card">
            {run.blocks.map(({ kind, doc }, j) =>
              kind === "removed" ? (
                <del key={j} className="block rounded-md bg-destructive/10 px-2 py-1 text-destructive-foreground">
                  <span className="sr-only">Removed: </span>
                  {text(doc)}
                </del>
              ) : (
                <ins key={j} className="block rounded-md bg-soft px-2 py-1 text-soft-foreground no-underline">
                  <span className="sr-only">Added: </span>
                  {text(doc)}
                </ins>
              ),
            )}
          </div>
        ) : (
          run.blocks.map(({ doc }, j) => <div key={`${i}-${j}`}>{text(doc)}</div>)
        ),
      )}
    </div>
  );

  // Anew for each version (one dismissed or published): stepping starts again at its first change.
  const key = (await prisma.articleRevision.findFirst({ where: { articleId: articleId ?? "" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } }))?.id ?? "new";
  return <ArticleChangesView key={key} changes={changes} article={text(after)} count={count} />;
}

/** The Verify runs whose fixes are on it, each once. */
const verifications = (review: TargetReview) => [...new Map(review.actions.flatMap((action) => (action.verification ? [[action.verification.id, action.verification] as const] : []))).values()];

const WAITS = ["pending", "stale", "scheduled"];

const param = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

/**
 * A post's or an article's review in Autopilot (`type`: feedback or articles): the pull requests with updates waiting
 * on it as chips, then its updates from each of them to approve, edit or dismiss, and those decided, to undo (an
 * article's: each pull request's in its chip's popover).
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
  const all = [...review.actions].sort((a, b) => UPDATE_ORDER.indexOf(a.kind) - UPDATE_ORDER.indexOf(b.kind));
  // A post's update is one, from each pull request's part.
  const updates = withPostUpdate(all, review.update);
  // `?select=<ids>` (an email's Edit, or its button opened by someone else) ticks those (a post's part: its update); else the likely ones.
  const select = param(searchParams.select);
  const likely = updates.filter((action) => action.applyLikely).map((action) => action.id);
  const ofPart = (id: string) => updates.find((update) => update.parts?.some((part) => part.id === id))?.id ?? id;
  const ticked = select === null || select === "likely" ? likely : [...new Set(select.split(",").map((value) => ofPart(value.trim())).filter(Boolean))];
  // Back from Approve in Autopilot's email (the act page): what it did, or who did it first, and when.
  const done = afterButton(all, param(searchParams.done), param(searchParams.button), param(searchParams.update));
  const emailed = [...new Set((await Promise.all(review.changes.map((change) => emailedAbout(change.id)))).flat())];
  const { post, article } = review;
  // An article's chips, each with its part in the article (its updates): every pull request's and Verify run's (those
  // decided too, to undo), those with an update waiting first.
  const chips = [
    ...review.changes.map((pr) => ({ key: pr.id, pr, parts: updates.filter((update) => update.codeChangeId === pr.id) })),
    ...(article ? verifications(review).map((verification) => ({ key: verification.id, verification, parts: updates.filter((update) => update.verification?.id === verification.id) })) : []),
  ].sort((a, b) => Number(b.parts.some((part) => WAITS.includes(part.status))) - Number(a.parts.some((part) => WAITS.includes(part.status))));

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
      {type === "articles" ? (
        <PullRequestChips outOfDate={chips.map(({ parts }) => parts.some((part) => part.status === "stale"))}>
          {chips.map(({ key, parts, ...of }) =>
            "pr" in of ? (
              <ArticlePartChip key={key} projectSlug={slug} updates={parts} canAnalyse={included} pr={of.pr} />
            ) : (
              <ArticlePartChip key={key} projectSlug={slug} updates={parts} canAnalyse={included} verification={of.verification} articleSlug={article!.slug} />
            ),
          )}
        </PullRequestChips>
      ) : (
        <PullRequestChips>
          {review.pullRequests.map((pr) => (
            <PullRequestChip key={pr.id} projectSlug={slug} pr={pr} />
          ))}
        </PullRequestChips>
      )}
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
      {type === "articles" ? (
        <ArticleReview
          projectSlug={slug}
          title={review.title}
          isNew={!review.articleId || !article}
          revision={review.revision ?? null}
          teammateEdit={review.teammateEdit ?? false}
          overview={review.overview ?? ""}
          updates={updates}
          view={await articleViews(review.articleId ?? null, review)}
        />
      ) : (
        <AutopilotReview
          projectSlug={slug}
          id={`${type}/${id}`}
          changes={review.changes}
          updates={updates}
          ticked={ticked}
          fromEmail={!select ? null : select === "likely" ? "likely" : "named"}
          emailed={emailed}
          previews={{}}
          canAnalyse={included}
        />
      )}
    </>
  );
}
