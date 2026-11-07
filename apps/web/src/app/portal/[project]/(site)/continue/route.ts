import { NextResponse } from "next/server";

import { appUrl, portalUrl } from "@/lib/hosts";
import { HANDOFF_STATE_COOKIE, HANDOFF_STATE_TTL_SECONDS, randomSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";

// <project>.tuti.so/continue?redirect=…[&sign-up=1|&reset=done] starts "Continue as <name>" (see lib/portal-handoff.ts).
export async function GET(request: Request, { params }: RouteContext<"/portal/[project]/continue">) {
  const { project } = await params;
  const state = randomSecret();
  const target = new URL("/continue", appUrl());
  target.searchParams.set("portal", project);
  target.searchParams.set("state", state);
  const { searchParams } = new URL(request.url);
  target.searchParams.set("redirect", safeRedirectPath(searchParams.get("redirect") ?? "", "/"));
  // "Create an account": the app's sign-up rather than its sign-in.
  if (searchParams.has("sign-up")) {
    target.searchParams.set("sign-up", "1");
  }
  // Just set a new password (server/password-reset.ts): the app's sign-in says so. Only that value goes on.
  if (searchParams.get("reset") === "done") {
    target.searchParams.set("reset", "done");
  }

  const response = NextResponse.redirect(target);
  response.cookies.set(HANDOFF_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: portalUrl(project).startsWith("https:"),
    path: "/",
    maxAge: HANDOFF_STATE_TTL_SECONDS,
  });
  return response;
}
