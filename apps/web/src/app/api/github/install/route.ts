import { NextResponse } from "next/server";

import { githubConfig, signValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { adminProject, INSTALL_COOKIE } from "@/server/github-connect";

/**
 * "Connect GitHub" (step 1 of 3): remembers the project in a short-lived signed
 * cookie and sends the owner or admin to the App's install page on GitHub.
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const project = await adminProject({ slug: new URL(request.url).searchParams.get("project") ?? "" });
  if (!project) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const response = NextResponse.redirect(`${config.url}/apps/${config.appSlug}/installations/new`);
  response.cookies.set(INSTALL_COOKIE, signValue("install", [project.id]), {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl().protocol === "https:",
    path: "/api/github",
    maxAge: 15 * 60,
  });
  return response;
}
