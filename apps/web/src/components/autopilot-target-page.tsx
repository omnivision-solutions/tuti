import type { JSONContent } from "@tiptap/core";
import { prisma } from "@tuti/db";
import { codeChangesEnabled, planIncludes } from "@tuti/shared";
import { notFound, redirect } from "next/navigation";

import { diffBlocks } from "@tuti/content";
import { RichText } from "@tuti/content/react";

import { ArticleChangesView, ArticleReview, PartChip } from "@/components/autopilot-article-review";
import { Outcome, PostReview } from "@/components/autopilot-review";
import { PageHeader } from "@/components/page-header";
import { PlanNotice } from "@/components/plan-notice";
import { PullRequestChips } from "@/components/pull-request-chip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { afterButton, plural, UPDATE_ORDER, withPostUpdate } from "@/lib/autopilot-words";
import { displayDoc } from "@/server/content";
import { getMembership } from "@/server/membership";
import { mediaUrls } from "@/server/media-urls";
import { type TargetReview, targetReview } from "@/server/operations/code-changes";

type Doc = ReturnType<typeof displayDoc>;

const WAITS = ["pending", "stale", "scheduled"];
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
  let before = article?.publishedAt ? displayDoc(article) : EMPTY;
  let after = article ? displayDoc(article.changes ?? article) : displayDoc({ content: payload?.content ?? null, body: payload?.body ?? "" });
  // Published, with nothing waiting: what its latest edits changed (their versions: the one the first was written on,
  // and the last one's), not the published text against itself. Kept while they can be undone.
  const edits = review.actions.filter((action) => action.kind === "article_edit" && action.status === "applied" && action.revision).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (article && edits.length > 0 && !review.actions.some((action) => WAITS.includes(action.status))) {
    const last = edits.at(-1)!;
    let first = last;
    // Layered: each written on the one before it.
    for (let under = edits.find((edit) => edit.revision === first.basedOn); under; under = edits.find((edit) => edit.revision === first.basedOn)) {
      first = under;
    }
    const versions = await prisma.articleRevision.findMany({ where: { id: { in: [first.basedOn ?? "", last.revision!] }, articleId: articleId! }, select: { id: true, body: true, content: true } });
    const [from, to] = [versions.find((one) => one.id === first.basedOn), versions.find((one) => one.id === last.revision)];
    if (from && to) {
      [before, after] = [displayDoc(from), displayDoc(to)];
    }
  }
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

const param = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

/**
 * A post's or an article's review in Autopilot (`type`: feedback or articles): the pull requests with updates on it as
 * chips, each one's part in its popover (to dismiss, write again or undo), then what happens to it: a post's status
 * change and comment, or the whole article with its changes, approved or dismissed as one.
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
    // Nothing from Autopilot on it any more (analysed again, its pull request had nothing for it): Autopilot's list, saying so.
    if (membership) {
      redirect(`/app/${slug}/autopilot?gone=${type === "feedback" ? "post" : "article"}`);
    }
    notFound();
  }
  // On a plan without Autopilot it's kept, but can't be analysed again (codeChanges.analyse refuses).
  const { plan, analyseCodeChanges } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true, analyseCodeChanges: true } });
  const included = planIncludes(plan, "codeChanges");
  // Why a pull request can't be analysed again (as codeChanges.analyse refuses), said where Write it again would be; null when it can.
  const analysisOff = !codeChangesEnabled()
    ? "AI isn't set up on this server"
    : !analyseCodeChanges
      ? "Autopilot is off in Settings → Autopilot"
      : !included
        ? "the plan doesn't include Autopilot"
        : null;
  const all = [...review.actions].sort((a, b) => UPDATE_ORDER.indexOf(a.kind) - UPDATE_ORDER.indexOf(b.kind));
  // A post's update is one, from each pull request's part.
  const updates = withPostUpdate(all, review.update);
  // Back from Approve in Autopilot's email (the act page): what it did, or who did it first, and when.
  const done = afterButton(all, param(searchParams.done), param(searchParams.button), param(searchParams.update));
  const { post, article } = review;
  const board = post ? (await prisma.post.findUnique({ where: { id }, select: { board: { select: { name: true } } } }))?.board.name : null;
  // The chips, each with its part in the post or article (its updates): every pull request's and Verify run's (those
  // decided too, to undo), those with an update waiting first.
  const chips = [
    ...review.changes.map((pr) => ({ key: pr.id, pr, parts: all.filter((update) => update.codeChangeId === pr.id) })),
    ...(article ? verifications(review).map((verification) => ({ key: verification.id, verification, parts: all.filter((update) => update.verification?.id === verification.id) })) : []),
  ].sort((a, b) => Number(b.parts.some((part) => WAITS.includes(part.status))) - Number(a.parts.some((part) => WAITS.includes(part.status))));

  return (
    <>
      <PageHeader
        back={{ href: `/app/${slug}/autopilot`, label: "Autopilot" }}
        title={review.title}
        meta={
          post
            ? [board, `#${post.number}`, plural(post.votes, "vote")].filter(Boolean).join(" · ")
            : article
              ? (article.collection ?? "No collection")
              : // Approving saves it in none: it's moved into one in Docs.
                "A new article, in no collection"
        }
      />
      <PullRequestChips outOfDate={chips.map(({ parts }) => parts.some((part) => part.status === "stale"))}>
        {chips.map(({ key, parts, ...of }) =>
          "pr" in of ? (
            <PartChip key={key} projectSlug={slug} updates={parts} all={all} canAnalyse={!analysisOff} writing={review.writing ?? []} reach={review.reach} pr={of.pr} />
          ) : (
            <PartChip key={key} projectSlug={slug} updates={parts} all={all} canAnalyse={!analysisOff} writing={review.writing ?? []} verification={of.verification} articleSlug={article!.slug} />
          ),
        )}
      </PullRequestChips>
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
      {/* Nothing waits: what became of it. */}
      {!all.some((update) => WAITS.includes(update.status)) && (
        <Outcome
          projectSlug={slug}
          updates={all}
          href={post ? `/app/${slug}/p/${post.number}` : article ? `/app/${slug}/docs/${article.slug}` : `/app/${slug}/docs`}
          label={post ? "Open the post" : article ? "Open the article" : "Open Docs"}
          status={post?.status}
        />
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
          changesReaders={review.changesReaders ?? true}
          outOfDate={review.outOfDate ?? []}
          writing={review.writing ?? []}
          writeFailed={review.writeFailed ?? []}
          analysisOff={analysisOff}
        />
      ) : (
        <PostReview
          projectSlug={slug}
          post={post!}
          reach={review.reach}
          update={updates.find((update) => WAITS.includes(update.status) && (update.kind === "resolves" || update.kind === "moves_forward")) ?? null}
        />
      )}
    </>
  );
}
