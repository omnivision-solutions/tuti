import { NextResponse } from "next/server";

import { appUrl, portalUrl } from "@/lib/hosts";
import { HANDOFF_STATE_COOKIE, HANDOFF_STATE_TTL_SECONDS, randomSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";

// <project>.tuti.so/continue?redirect=… starts "Continue as <name>" (see lib/portal-handoff.ts).
export async function GET(request: Request, { params }: RouteContext<"/portal/[project]/continue">) {
  const { project } = await params;
  const state = randomSecret();
  const target = new URL("/continue", appUrl());
  target.searchParams.set("portal", project);
  target.searchParams.set("state", state);
  target.searchParams.set("redirect", safeRedirectPath(new URL(request.url).searchParams.get("redirect") ?? "", "/"));

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
