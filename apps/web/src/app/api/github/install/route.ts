import { NextResponse } from "next/server";

import { githubConfig } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { adminProject, authorizeRedirect, rememberInstall } from "@/server/github-connect";

/**
 * "Connect GitHub": first asks GitHub (its web authorization flow) which accounts the person
 * already has the App on, so they can pick one in Tuti; the callback sends them on to install
 * it if there are none. `?new=1` ("Install on another account") goes straight to the App's
 * install page. Either way the project is remembered in a short-lived signed cookie, for the
 * Setup URL that GitHub comes back to after an install.
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const project = await adminProject({ slug: params.get("project") ?? "" });
  if (!project) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const response =
    params.get("new") === "1"
      ? NextResponse.redirect(`${config.url}/apps/${config.appSlug}/installations/new`)
      : authorizeRedirect(config, project.id, "", "choose");
  return rememberInstall(response, project.id);
}
