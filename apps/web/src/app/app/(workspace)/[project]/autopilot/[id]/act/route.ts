import { POST_UPDATE, postVersion, readAutopilotButton, reviewPath } from "@tuti/jobs";
import type { CodeChangeActionKind } from "@tuti/db";
import { log } from "@tuti/shared";
import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";

import { getSession } from "@/server/session";
import { sessionContext } from "@/server/trpc/context";
import { createCaller } from "@/server/trpc/server";

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
  // Publish now or Stop: the ones the email showed.
  const [kind, list = ""] = which.split(":") as ["publish" | "stop", string];
  const ids = actionId ? [actionId] : list.split(",").filter(Boolean);
  // The page's own context function: the cookie session, through the router, which decides whether they may.
  const signedIn = sessionContext(await getSession());
  if (!signedIn.who) {
    redirect(`/app/auth/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  const caller = createCaller(signedIn);
  // The updates it names, as they are now: refused (not on the team), nothing to show them.
  const read = async () => {
    try {
      return (await caller.codeChanges.button({ project: slug, id, actions: ids })).actions;
    } catch (error) {
      if (error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR") {
        return null;
      }
      throw error;
    }
  };
  const named = await read();
  // Approve's update is reviewed on its post's or article's page (analysed again since, it's gone: the activity page).
  const approving = actionId ? (named?.[0] ?? null) : null;
  const review = (query: string) => {
    const path = approving && reviewPath({ ...approving, kind: approving.kind as CodeChangeActionKind });
    redirect(path ? `/app/${slug}/autopilot/${path}${query}` : `/app/${slug}/autopilot/activity/${encodeURIComponent(id)}${query}`);
  };
  if (signedIn.who.kind !== "session" || signedIn.who.userId !== userId || expired) {
    // Approve's update, on its review; Publish now's or Stop's, on the activity page, each a link to its review.
    if (actionId) {
      review("");
    }
    page("");
  }
  if (!named) {
    notFound();
  }
  // Each action through the router as the caller (`.call`: the caller reads a procedure called `apply` or `call` as the
  // function's own).
  const run = (name: "applyMany" | "publishNow" | "stop", input: object) =>
    (caller.codeChangeActions[name] as (input: unknown) => Promise<unknown>).call(undefined, { project: slug, ...input });
  // An email sent before a post's update was one (its Approve has no version): only while the update is still just the
  // part it showed, pinned to that (a part landing meanwhile refuses it under the lock). Anything more, nothing's done:
  // its review says the update changed, to approve there.
  let pinned = revision;
  if (actionId && !revision && approving && POST_UPDATE.includes(approving.kind as CodeChangeActionKind) && approving.postId) {
    const parts = approving.parts ?? [];
    if (parts.length > 1 && parts.includes(actionId)) {
      review(`?done=changed&button=approve&update=${encodeURIComponent(actionId)}`);
    }
    pinned = postVersion([actionId]);
  }
  if (actionId) {
    const { results } = (await run("applyMany", { actions: [{ id: actionId, ...(pinned && { revision: pinned }) }] })) as {
      results: { status: string; code?: string }[];
    };
    const [result] = results;
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
      await run(kind === "publish" ? "publishNow" : "stop", { id: action.id });
      done++;
    } catch (error) {
      // As approving several says it (applyCodeChangeActions), and the rest go on: went before the failure, it's done;
      // can't tell, it's to check before trying again; went (or stopped) meanwhile, nothing to do; refused (its
      // article changed, say) or failed, it waits for the team now. The page says which.
      // An operation's own refusal is a tRPC error with its status; its failure's `saved` and code are on what it threw.
      const cause = (error instanceof TRPCError ? error.cause : error) as { saved?: boolean | "unknown"; code?: unknown } | undefined;
      const refused = error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR";
      const saved = cause?.saved;
      if (saved === true) {
        done++;
      } else if (saved === "unknown") {
        log.error("Autopilot's email button: couldn't tell whether an update went", { error, actionId: action.id });
        unsure.push(action.id);
      } else if (!(refused && cause?.code === "not_scheduled")) {
        if (!refused) {
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
  const now = (await read()) ?? [];
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
