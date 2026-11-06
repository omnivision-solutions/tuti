import { prisma } from "@tuti/db";
import { POST_UPDATE, postUpdate, postVersion, readAutopilotButton, reviewPath } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { notFound, redirect } from "next/navigation";

import { getMembership } from "@/server/membership";
import { OperationError } from "@/server/operations";
import { applyCodeChangeActions, publishCodeChangeActionNow, stopCodeChangeAction } from "@/server/operations/code-changes";
import { call } from "@/server/operations/run";
import { getSession } from "@/server/session";

/**
 * A button in Autopilot's email (Approve, Publish now, Stop): one click acts for the person it was sent
 * to, signed in, then shows what was done (`done`): Approve on its post's or article's review, the others on the pull
 * request's activity page. Signed out, they sign in first and it's done after. Anyone else (a forwarded email, a
 * teammate), or a token out of date, gets Approve's update's review, to approve there, or the activity
 * page. Mail scanners open links without a session: they only reach the sign-in page.
 */
export async function GET(request: Request, context: RouteContext<"/app/[project]/autopilot/[id]/act">) {
  const { project: slug, id } = await context.params;
  const url = new URL(request.url);
  const page = (query: string) => redirect(`/app/${slug}/autopilot/activity/${encodeURIComponent(id)}${query}`);
  const button = readAutopilotButton(url.searchParams.get("token") ?? "");
  if (!button || button.codeChangeId !== id) {
    page("");
  }
  const { button: which, userId, expired } = button!;
  // Approve names its update, and for an article's edit the version the email showed (`<id>@<revision>`).
  const [actionId = null, revision] = which.startsWith("approve:") ? which.slice("approve:".length).split("@") : [];
  // Approve's update is reviewed on its post's or article's page (analysed again since, it's gone: the activity page).
  const approving = actionId
    ? await prisma.codeChangeAction.findFirst({ where: { id: actionId, codeChangeId: id }, select: { id: true, kind: true, postId: true, articleId: true } })
    : null;
  const review = (query: string) => {
    const path = approving && reviewPath(approving);
    redirect(path ? `/app/${slug}/autopilot/${path}${query}` : `/app/${slug}/autopilot/activity/${encodeURIComponent(id)}${query}`);
  };
  const session = await getSession();
  if (!session) {
    redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  if (session.user.id !== userId || expired) {
    // Approve's update, on its review; Publish now's or Stop's, on the activity page, each a link to its review.
    if (actionId) {
      review("");
    }
    page("");
  }
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const as = { actor: { kind: "user" as const, userId }, projectId: membership.project.id };
  // An email sent before a post's update was one (its Approve has no version): only while the update is still just the
  // part it showed, pinned to that (a part landing meanwhile refuses it under the lock). Anything more, nothing's done:
  // its review says the update changed, to approve there.
  let pinned = revision;
  if (actionId && !revision && approving && POST_UPDATE.includes(approving.kind) && approving.postId) {
    const { parts } = await postUpdate(approving.postId);
    if (parts.length > 1 && parts.some((part) => part.id === actionId)) {
      review(`?done=changed&button=approve&update=${encodeURIComponent(actionId)}`);
    }
    pinned = postVersion([actionId]);
  }
  if (actionId) {
    const [result] = (await call(applyCodeChangeActions, as, { actions: [{ id: actionId, ...(pinned && { revision: pinned }) }] })).results;
    // Analysed again since: the update it named was replaced; the page has what's there now.
    if (result?.status === "failed" && result.code === "not_found") {
      page("?done=replaced&button=approve");
    }
    // Couldn't tell whether it went (check it first), or failed for now (try again): said so; refused: done already, or why not.
    const failed = result?.status === "failed" ? result.code : null;
    // The article changed since the email: nothing done, and its review says so, to review again.
    if (failed === "changed") {
      review(`?done=changed&button=approve&update=${encodeURIComponent(actionId)}`);
    }
    const done = result?.status === "applied" ? "approved" : failed === "unknown" ? "unknown" : failed === "internal" ? "failed" : "already";
    review(`?done=${done}&button=approve&update=${encodeURIComponent(actionId)}`);
  }
  // Publish now or Stop: the ones the email showed, if they're still going out by themselves.
  const [kind, list = ""] = which.split(":") as ["publish" | "stop", string];
  const ids = list.split(",").filter(Boolean);
  const named = await prisma.codeChangeAction.findMany({
    where: { id: { in: ids }, codeChangeId: id, codeChange: { projectId: membership.project.id } },
    select: { id: true, status: true },
  });
  // Some of them not there any more: analysed again since. It replaces what was still scheduled and keeps what the
  // team decided, so none it named goes out by itself now; what replaced them may: the page says so.
  if (named.length < ids.length) {
    page(`?done=replaced&button=${kind}`);
  }
  const scheduled = named.filter((action) => action.status === "SCHEDULED");
  let done = 0;
  const held: string[] = [];
  const unsure: string[] = [];
  for (const action of scheduled) {
    try {
      await call(kind === "publish" ? publishCodeChangeActionNow : stopCodeChangeAction, as, { id: action.id });
      done++;
    } catch (error) {
      // As approving several says it (applyCodeChangeActions), and the rest go on: went before the failure, it's done;
      // can't tell, it's to check before trying again; went (or stopped) meanwhile, nothing to do; refused (its
      // article changed, say) or failed, it waits for the team now. The page says which.
      const { saved } = error as { saved?: boolean | "unknown" };
      if (saved === true) {
        done++;
      } else if (saved === "unknown") {
        log.error("Autopilot's email button: couldn't tell whether an update went", { error, actionId: action.id });
        unsure.push(action.id);
      } else if (!(error instanceof OperationError && error.code === "not_scheduled")) {
        if (!(error instanceof OperationError)) {
          log.error("Autopilot's email button failed", { error, actionId: action.id });
        }
        held.push(action.id);
      }
    }
  }
  const checks = [...unsure, ...held];
  const heldQuery = `${held.length > 0 ? `&held=${held.length}` : ""}${unsure.length > 0 ? `&unsure=${unsure.length}` : ""}`;
  // Those it named that someone decided first: Stop says which went out already (to undo), Publish now which a
  // teammate stopped (they wait).
  const now = await prisma.codeChangeAction.findMany({ where: { id: { in: ids }, codeChangeId: id }, select: { status: true, waitReason: true } });
  const went = kind === "stop" ? now.filter((action) => action.status === "APPLIED").length : 0;
  const kept = kind === "publish" ? now.filter((action) => action.status === "PENDING" && action.waitReason?.startsWith("Stopped by")).length : 0;
  const othersQuery = `${went > 0 ? `&went=${went}` : ""}${kept > 0 ? `&kept=${kept}` : ""}`;
  if (done === 0 && checks.length === 0) {
    // Nothing it showed is going out any more: who did what to the first, and when; and those counts.
    page(`?done=already&button=${kind}${ids[0] ? `&update=${encodeURIComponent(ids[0])}` : ""}${othersQuery}`);
  }
  // None of them done: none went (or stopped), and the page says so.
  page(`?done=${done === 0 ? (unsure.length > 0 ? "unsure" : "refused") : kind === "publish" ? "published" : "stopped"}&button=${kind}${heldQuery}${othersQuery}`);
}
