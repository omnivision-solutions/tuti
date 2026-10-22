import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { githubConfig } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { accountsFromCookie, ACCOUNTS_COOKIE, adminProject, authorizeRedirect } from "@/server/github-connect";

/**
 * A GitHub account picked after "Connect GitHub": one GitHub said the person has the App on.
 * GitHub's web authorization flow (which comes straight back once they've authorized the App)
 * then confirms it again, and the callback connects it.
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
  const installationId = Number(params.get("installation"));
  const offered = accountsFromCookie((await cookies()).get(ACCOUNTS_COOKIE)?.value ?? "", project.id);
  if (!offered.some((installation) => installation.id === installationId)) {
    return NextResponse.redirect(new URL(`/app/${project.slug}/settings/integrations?github=expired`, appUrl()));
  }
  return authorizeRedirect(config, project.id, installationId, "install");
}
