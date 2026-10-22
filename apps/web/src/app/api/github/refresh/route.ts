import { prisma } from "@tuti/db";
import { NextResponse } from "next/server";

import { githubConfig, signValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { adminProject } from "@/server/github-connect";

/**
 * "Refresh" on Settings → Integrations: asks GitHub again (its web authorization flow, which
 * comes straight back once the person has authorized the App) which of the installation's
 * repositories the person can access; the callback updates the list.
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
  const connection = await prisma.githubInstallation.findUnique({ where: { projectId: project.id }, select: { installationId: true } });
  if (!connection) {
    return NextResponse.redirect(new URL(`/app/${project.slug}/settings/integrations`, appUrl()));
  }
  const authorize = new URL(`${config.url}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: new URL("/api/github/callback", appUrl()).href,
    state: signValue("callback", [project.id, String(connection.installationId), "refresh"]),
  }).toString();
  return NextResponse.redirect(authorize);
}
