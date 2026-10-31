import { prisma } from "@tuti/db";
import { readAutopilotButton } from "@tuti/jobs";
import { notFound, redirect } from "next/navigation";

import { getMembership } from "@/server/membership";
import { OperationError } from "@/server/operations";
import { applyCodeChangeActions, publishCodeChangeActionNow, stopCodeChangeAction } from "@/server/operations/code-changes";
import { call } from "@/server/operations/run";
import { getSession } from "@/server/session";

/**
 * A button in Autopilot's email (Approve, Publish now, Stop): one click acts for the person it was sent
 * to, signed in, then shows the change with what was done (`done`). Signed out, they sign in first and
 * it's done after. Anyone else (a forwarded email, a teammate), or a token out of date, gets the review
 * page with those updates ticked, to confirm there. Mail scanners open links without a session: they
 * only reach the sign-in page.
 */
export async function GET(request: Request, context: RouteContext<"/app/[project]/autopilot/[id]/act">) {
  const { project: slug, id } = await context.params;
  const url = new URL(request.url);
  const page = (query: string) => redirect(`/app/${slug}/autopilot/${encodeURIComponent(id)}${query}`);
  const button = readAutopilotButton(url.searchParams.get("token") ?? "");
  if (!button || button.codeChangeId !== id) {
    page("?select=likely");
  }
  const { button: which, userId, expired } = button!;
  const actionId = which.startsWith("approve:") ? which.slice("approve:".length) : null;
  const session = await getSession();
  if (!session) {
    redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  if (session.user.id !== userId || expired) {
    page(actionId ? `?select=${encodeURIComponent(actionId)}` : "?select=likely");
  }
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const as = { actor: { kind: "user" as const, userId }, projectId: membership.project.id };
  if (actionId) {
    const [result] = (await call(applyCodeChangeActions, as, { actions: [{ id: actionId }] })).results;
    // Analysed again since: the update it named was replaced; the page has what's there now.
    if (result?.status === "failed" && result.code === "not_found") {
      page("?select=likely&done=replaced");
    }
    page(`?done=${result?.status === "applied" ? "approved" : "already"}&update=${encodeURIComponent(actionId)}`);
  }
  // Publish now or Stop: the ones the email showed, if they're still going out by themselves.
  const [kind, list = ""] = which.split(":") as ["publish" | "stop", string];
  const ids = list.split(",").filter(Boolean);
  const scheduled = await prisma.codeChangeAction.findMany({
    where: { id: { in: ids }, codeChangeId: id, codeChange: { projectId: membership.project.id }, status: "SCHEDULED" },
    select: { id: true },
  });
  let done = 0;
  const held: string[] = [];
  for (const action of scheduled) {
    try {
      await call(kind === "publish" ? publishCodeChangeActionNow : stopCodeChangeAction, as, { id: action.id });
      done++;
    } catch (error) {
      if (!(error instanceof OperationError)) {
        throw error;
      }
      // Went (or stopped) meanwhile: nothing to do. Refused (its article changed, say): it waits for the team now, and the page says so.
      if (error.code !== "not_scheduled") {
        held.push(action.id);
      }
    }
  }
  const heldQuery = held.length > 0 ? `&held=${held.length}&select=${held.map(encodeURIComponent).join(",")}` : "";
  if (done === 0 && held.length === 0) {
    // Nothing it showed is going out any more: who did what to it, and when.
    page(`?done=already${ids[0] ? `&update=${encodeURIComponent(ids[0])}` : ""}`);
  }
  page(`?done=${kind === "publish" ? "published" : "stopped"}${heldQuery}`);
}
