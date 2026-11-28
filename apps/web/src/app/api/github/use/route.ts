import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { githubConfig } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { accountsFromCookie, ACCOUNTS_COOKIE, authorizeRedirect, crossSite } from "@/server/github-connect";
import { cookieCaller, unlessRefused } from "@/server/trpc/server";

/**
 * A GitHub account picked after "Connect GitHub": one GitHub said the person has the App on, or
 * the one the project is on ("Reconnect", to list repositories given access since). GitHub's web
 * authorization flow (which comes straight back once they've authorized the App) then confirms
 * it again, and the callback connects it. Owners and admins only (githubConnect.get).
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const slug = params.get("project") ?? "";
  const connect = !crossSite(request) && (await unlessRefused((await cookieCaller()).githubConnect.get({ project: slug })));
  if (!connect) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const installationId = Number(params.get("installation"));
  const offered = accountsFromCookie((await cookies()).get(ACCOUNTS_COOKIE)?.value ?? "", connect.projectId);
  const current = Number.isSafeInteger(installationId) && connect.installationId === installationId;
  if (!current && !offered.some((installation) => installation.id === installationId)) {
    return NextResponse.redirect(new URL(`/app/${slug}/settings/integrations?github=expired`, appUrl()));
  }
  return authorizeRedirect(config, { slug, userId: connect.userId }, installationId, "install");
}
