import { NextResponse } from "next/server";

import { githubConfig, signValue, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { ACCOUNTS_COOKIE, INSTALL_COOKIE } from "@/server/github-connect";
import { cookieCaller, unlessRefused } from "@/server/trpc/server";

/**
 * The App's Callback URL (step 3 of 3): GitHub's web authorization flow returns `code` and our `state`, which names
 * the project. The installation is connected only if the state is ours and fresh, the signed-in account administers
 * the project, and GitHub says the person who authorized can see the installation, so nobody can claim another's
 * (githubConnect.finish, which also checks the state is this project's and that whoever finishes started it). The
 * repositories of it they can access are the ones the project can add.
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? "";
  const slug = verifyValue("callback", state)?.[0];
  const finished = slug && (await unlessRefused((await cookieCaller()).githubConnect.finish({ project: slug, state, code: params.get("code") ?? undefined })));
  if (!slug || !finished || finished.result === "expired") {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  // Connected: on to its settings; otherwise back to the integrations, to try again.
  const done = (result: string) => {
    const page = result === "connected" ? "integrations/github" : "integrations";
    const response = NextResponse.redirect(new URL(`/app/${slug}/settings/${page}?github=${result}`, appUrl()));
    response.cookies.delete({ name: INSTALL_COOKIE, path: "/api/github" });
    response.cookies.delete({ name: ACCOUNTS_COOKIE, path: "/" });
    return response;
  };
  // "Connect GitHub" and none to pick: on to install it.
  if (finished.result === "install") {
    return NextResponse.redirect(`${config.url}/apps/${config.appSlug}/installations/new`);
  }
  if (finished.result !== "choose") {
    return done(finished.result);
  }
  // The accounts the person has the App on, to pick from; already connected ("Switch account"), on the GitHub page.
  const page = finished.switching ? "integrations/github" : "integrations";
  const response = NextResponse.redirect(new URL(`/app/${slug}/settings/${page}?github=choose`, appUrl()));
  const accounts = finished.accounts.map((account) => `${account.id}:${account.type}:${account.login}`);
  response.cookies.set(ACCOUNTS_COOKIE, signValue("accounts", [finished.projectId, ...accounts]), {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl().protocol === "https:",
    path: "/",
    maxAge: 15 * 60,
  });
  return response;
}
