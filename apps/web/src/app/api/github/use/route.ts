import { prisma } from "@tuti/db";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { githubConfig } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { accountsFromCookie, ACCOUNTS_COOKIE, adminProject, authorizeRedirect, crossSite } from "@/server/github-connect";

/**
 * A GitHub account picked after "Connect GitHub": one GitHub said the person has the App on, or
 * the one the project is on ("Reconnect", to list repositories given access since). GitHub's web
 * authorization flow (which comes straight back once they've authorized the App) then confirms
 * it again, and the callback connects it.
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const project = !crossSite(request) && (await adminProject({ slug: params.get("project") ?? "" }));
  if (!project) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const installationId = Number(params.get("installation"));
  const offered = accountsFromCookie((await cookies()).get(ACCOUNTS_COOKIE)?.value ?? "", project.id);
  const current = Number.isSafeInteger(installationId) && (await prisma.githubInstallation.count({ where: { projectId: project.id, installationId } }));
  if (!current && !offered.some((installation) => installation.id === installationId)) {
    return NextResponse.redirect(new URL(`/app/${project.slug}/settings/integrations?github=expired`, appUrl()));
  }
  return authorizeRedirect(config, project, installationId, "install");
}
