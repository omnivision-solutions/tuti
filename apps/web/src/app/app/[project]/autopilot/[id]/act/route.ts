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
    const { results } = await call(applyCodeChangeActions, as, { actions: [{ id: actionId }] });
    page(`?done=${results[0]?.status === "applied" ? "approved" : "already"}&update=${encodeURIComponent(actionId)}`);
  }
  // Publish now or Stop: the change's updates still going out by themselves.
  const scheduled = await prisma.codeChangeAction.findMany({
    where: { codeChangeId: id, codeChange: { projectId: membership.project.id }, status: "SCHEDULED" },
    select: { id: true },
  });
  let done = 0;
  for (const action of scheduled) {
    try {
      await call(which === "publish" ? publishCodeChangeActionNow : stopCodeChangeAction, as, { id: action.id });
      done++;
    } catch (error) {
      // One went (or was stopped) meanwhile: the rest still are.
      if (!(error instanceof OperationError)) {
        throw error;
      }
    }
  }
  page(`?done=${done === 0 ? "already" : which === "publish" ? "published" : "stopped"}`);
}
