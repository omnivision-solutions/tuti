import { NextResponse } from "next/server";

import { githubConfig, installationForUser, installationsForUser, signValue, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { ACCOUNTS_COOKIE, adminProject, INSTALL_COOKIE, saveConnection } from "@/server/github-connect";

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
  // Connected (or refreshed): on to its settings; otherwise back to the integrations, to try again.
  const done = (result: string) => {
    const page = result === "connected" || result === "refreshed" ? "integrations/github" : "integrations";
    const response = NextResponse.redirect(new URL(`/app/${project.slug}/settings/${page}?github=${result}`, appUrl()));
    response.cookies.delete({ name: INSTALL_COOKIE, path: "/api/github" });
    response.cookies.delete({ name: ACCOUNTS_COOKIE, path: "/" });
    return response;
  };

  const code = params.get("code");
  const redirectUri = new URL("/api/github/callback", appUrl()).href;
  // "Connect GitHub": the accounts the person has the App on, to pick from; none, so on to install it.
  if (purpose === "choose") {
    const installations = code ? await installationsForUser(config, code, redirectUri).catch(() => null) : null;
    if (!installations) {
      return done("unconfirmed");
    }
    if (installations.length === 0) {
      return NextResponse.redirect(`${config.url}/apps/${config.appSlug}/installations/new`);
    }
    const response = NextResponse.redirect(new URL(`/app/${project.slug}/settings/integrations?github=choose`, appUrl()));
    const accounts = installations.slice(0, 50).map((i) => `${i.id}:${i.account.type}:${i.account.login}`);
    response.cookies.set(ACCOUNTS_COOKIE, signValue("accounts", [project.id, ...accounts]), {
      httpOnly: true,
      sameSite: "lax",
      secure: appUrl().protocol === "https:",
      path: "/",
      maxAge: 15 * 60,
    });
    return response;
  }

  const installationId = Number(installation);
  const account = code && (await installationForUser(config, code, redirectUri, installationId).catch(() => null));
  if (!account) {
    return done("unconfirmed");
  }
  await saveConnection(project, installationId, account);
  return done(purpose === "refresh" ? "refreshed" : "connected");
}
