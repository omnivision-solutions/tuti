import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { githubConfig, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { authorizeRedirect, INSTALL_COOKIE } from "@/server/github-connect";
import { cookieCaller, unlessRefused } from "@/server/trpc/server";

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
  // The project the install cookie remembers, while its owners and admins may still connect it (githubConnect.get).
  const slug = verifyValue("install", (await cookies()).get(INSTALL_COOKIE)?.value ?? "")?.[0];
  const connect = slug && (await unlessRefused((await cookieCaller()).githubConnect.get({ project: slug })));
  if (!slug || !connect) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const installationId = Number(params.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return NextResponse.redirect(new URL(`/app/${slug}/settings/integrations?github=unconfirmed`, appUrl()));
  }
  return authorizeRedirect(config, { slug, userId: connect.userId }, installationId, "install");
}
