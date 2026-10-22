import { NextResponse } from "next/server";

import { githubConfig, installationForUser, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { adminProject, INSTALL_COOKIE, saveConnection } from "@/server/github-connect";

/**
 * The App's Callback URL (step 3 of 3): GitHub's web authorization flow returns
 * `code` and our `state`. The installation is connected only if the state is ours
 * and fresh, the signed-in account administers the project, and GitHub says the
 * person who authorized can see the installation, so nobody can claim another's. The
 * repositories of it they can access are the ones the project can include. "Refresh"
 * (/api/github/refresh) comes back here too, to update them.
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const [projectId, installation, purpose] = verifyValue("callback", params.get("state") ?? "") ?? [];
  const project = projectId && (await adminProject({ id: projectId }));
  if (!project) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const done = (result: string) => {
    const response = NextResponse.redirect(new URL(`/app/${project.slug}/settings/integrations?github=${result}`, appUrl()));
    response.cookies.delete({ name: INSTALL_COOKIE, path: "/api/github" });
    return response;
  };

  const installationId = Number(installation);
  const code = params.get("code");
  const account =
    code &&
    (await installationForUser(config, code, new URL("/api/github/callback", appUrl()).href, installationId).catch(() => null));
  if (!account) {
    return done("unconfirmed");
  }
  await saveConnection(project, installationId, account);
  return done(purpose === "refresh" ? "refreshed" : "connected");
}
