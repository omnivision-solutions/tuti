import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AnalyseCodeChangeButton } from "@/components/code-changes";
import { GoesOut } from "@/components/goes-out";
import { PageHeader } from "@/components/page-header";
import { PlanNotice } from "@/components/plan-notice";
import { PullRequestChip } from "@/components/pull-request-chip";
import { TargetBadge } from "@/components/target-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { afterButton, targetBadge } from "@/lib/autopilot-words";
import { getMembership } from "@/server/membership";
import { type CodeChangeDetail, codeChangeDetail } from "@/server/operations/code-changes";

type Update = CodeChangeDetail["actions"][number];

/** Where a post's or article's updates from this pull request are: waiting, going out, or what became of them. */
function where(updates: Update[]) {
  const scheduled = updates.find((update) => update.status === "scheduled");
  if (updates.some((update) => update.status === "pending" || update.status === "stale")) {
    return "Waits for you";
  }
  if (scheduled?.dueAt) {
    return <GoesOut at={scheduled.dueAt} />;
  }
  // Autopilot couldn't tell whether it went (an email's Publish now, say): this is the one to check.
  if (updates.some((update) => update.unsure)) {
    return "Couldn't tell whether it went out: check it";
  }
  const applied = updates.find((update) => update.status === "applied");
  return applied ? (applied.auto ? "Applied by Autopilot" : "Approved") : updates.some((update) => update.status === "undone") ? "Undone" : "Dismissed";
}

/**
 * A merged pull request's activity in Autopilot: its title, its chip, what changed for users, why Autopilot made its
 * updates (folded away), and the posts and articles it touched as a tree (Help center → collection → article, then
 * Feedback), each opening its review. One being read, paused, failed or with nothing to do says so, with its button.
 */
export default async function CodeChangeActivityPage(props: PageProps<"/app/[project]/autopilot/activity/[id]">) {
  const [{ project: slug, id }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const membership = await getMembership(slug);
  const change = membership && (await codeChangeDetail(membership.project.id, id));
  if (!change) {
    notFound();
  }
  // On a plan without Autopilot it's kept, but can't be analysed again (codeChanges.analyse refuses).
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { plan: true } });
  const included = planIncludes(plan, "codeChanges");
  const param = (name: string) => (typeof searchParams[name] === "string" ? searchParams[name] : null);
  // Back from Publish now or Stop in Autopilot's email (the act page): what it did, or who did it first.
  const done = afterButton(change.actions, param("done"), param("button"), param("update"), {
    held: Number(param("held") ?? 0) || 0,
    unsure: Number(param("unsure") ?? 0) || 0,
    went: Number(param("went") ?? 0) || 0,
    kept: Number(param("kept") ?? 0) || 0,
  });

  // What it touched, by post and article (the changelog line is written into the draft by itself).
  const touched = new Map<string, Update[]>();
  for (const update of change.actions) {
    if (update.reviewPath && update.kind !== "changelog_line") {
      touched.set(update.reviewPath, [...(touched.get(update.reviewPath) ?? []), update]);
    }
  }
  const targets = [...touched].map(([path, updates]) => ({
    path,
    updates,
    title: updates[0]!.post?.title ?? updates.find((update) => update.article)?.article?.title ?? updates[0]!.title ?? "",
    post: updates[0]!.post,
    collection: updates.find((update) => update.article)?.article?.collection ?? null,
    // What it does: not what the team dismissed or undid (no badge, when that's all).
    badge: targetBadge(updates.filter((update) => update.status !== "dismissed" && update.status !== "undone").map((update) => update.kind)),
  }));
  const articles = targets.filter((target) => !target.post);
  const posts = targets.filter((target) => target.post);
  const collections = [...new Set(articles.map((target) => target.collection))];
  const item = (target: (typeof targets)[number]) => (
    <li key={target.path}>
      <Link href={`/app/${slug}/autopilot/${target.path}`} className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
        <span className="min-w-0 flex-1 break-words">{target.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{where(target.updates)}</span>
        <TargetBadge badge={target.badge} className="tracking-wide uppercase" />
      </Link>
    </li>
  );

  return (
    <>
      <PageHeader back={{ href: `/app/${slug}/autopilot/activity`, label: "Activity" }} title={change.title} />
      <div>
        <PullRequestChip projectSlug={slug} pr={change} />
      </div>
      {done && (
        <Alert>
          <AlertDescription>{done}</AlertDescription>
        </Alert>
      )}
      {change.state === "analysing" && (
        <Alert>
          <AlertDescription>Autopilot is reading this pull request. What it changes shows here when it&apos;s done.</AlertDescription>
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
        <section aria-labelledby="what-changed" className="flex flex-col gap-2">
          <h2 id="what-changed" className="font-semibold">
            What changed for users
          </h2>
          <p>{change.summary}</p>
        </section>
      )}
      {change.why && (
        <details className="rounded-xl border bg-card px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">Why Autopilot made this change</summary>
          <p className="pt-2 text-muted-foreground">{change.why}</p>
        </details>
      )}
      {(targets.length > 0 || change.changelog) && (
        <section aria-labelledby="review-changes" className="rounded-xl border bg-card text-sm">
          <h2 id="review-changes" className="border-b px-4 py-3 font-semibold">
            Review changes
          </h2>
          <div className="flex flex-col gap-4 p-4">
            {articles.length > 0 && (
              <section aria-label="Help center" className="flex flex-col gap-1">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Help center</h3>
                <ul className="flex flex-col gap-2 border-l pl-3">
                  {collections.map((collection) => (
                    <li key={collection ?? ""} className="flex flex-col">
                      <span className="text-muted-foreground">{collection ?? "No collection"}</span>
                      <ul className="flex flex-col border-l pl-3">{articles.filter((target) => target.collection === collection).map(item)}</ul>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {posts.length > 0 && (
              <section aria-label="Feedback" className="flex flex-col gap-1">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Feedback</h3>
                <ul className="flex flex-col border-l pl-3">{posts.map(item)}</ul>
              </section>
            )}
            {change.changelog && (
              <p className="text-muted-foreground">
                Its line in the changelog is in{" "}
                <Link href={`/app/${slug}/changelog/${change.changelog.number}`} className="font-medium text-foreground hover:underline">
                  {change.changelog.title}
                </Link>
                .
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
