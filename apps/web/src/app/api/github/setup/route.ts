import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { githubConfig, signValue, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { adminProject, INSTALL_COOKIE } from "@/server/github-connect";

/**
 * The App's Setup URL (step 2 of 3): GitHub sends people here after installing,
 * with only `installation_id`, which anyone could type. So nothing is connected
 * yet: we ask GitHub (its web authorization flow) who this person is, carrying
 * the project and installation in a signed `state` to the callback.
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const projectId = verifyValue("install", (await cookies()).get(INSTALL_COOKIE)?.value ?? "")?.[0];
  const project = projectId && (await adminProject({ id: projectId }));
  if (!project) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const installationId = Number(params.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return NextResponse.redirect(new URL(`/app/${project.slug}/settings?github=unconfirmed`, appUrl()));
  }
  const authorize = new URL(`${config.url}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: new URL("/api/github/callback", appUrl()).href,
    state: signValue("callback", [project.id, String(installationId)]),
  }).toString();
  return NextResponse.redirect(authorize);
}
