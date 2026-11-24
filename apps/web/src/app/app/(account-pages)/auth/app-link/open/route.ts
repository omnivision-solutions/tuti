import { prisma } from "@tuti/db";

import { appSignInLink, appSignInReturn } from "@/lib/app-sign-in";
import { auth } from "@/lib/auth";
import { requestTarget } from "@/server/custom-domains";
import { pendingSignInLink } from "@/server/sign-in-link-lookup";

/**
 * "Open the app" on the page the mobile app's sign-in link opens (/app/auth/app-link, lib/app-sign-in.ts): uses the
 * token up, starts a session for the account and redirects the browser to the app, through its link scheme, with the
 * `state` the app asked with and a code for it to exchange for the session (lib/app-sign-in.ts puts the code there in
 * place of the session, and takes the session's cookie out of the answer). A dead link tells the app `error` instead.
 * A form's post answered with a redirect, as a provider's sign-in ends: the way browsers open an app, with nothing for
 * a script to do. This browser, which may be anyone's (a link opened at a desk), stays as it was, signed in or not.
 * Not the app's host, or a link nothing is kept of: back to the page, which says the link doesn't work.
 */
export async function POST(request: Request) {
  const to = (location: string) => new Response(null, { status: 303, headers: { location } });
  const form = await request.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  // What the app asked with, kept with the link: where to go back to is never the form's to say.
  const asked = (await requestTarget(request.headers.get("host"))).kind === "app" && token.length <= 100 ? await appSignInLink(token) : null;
  if (!asked) {
    return to("/app/auth/app-link");
  }
  const back = appSignInReturn(asked.state);
  const link = await pendingSignInLink(null, token);
  // An account that exists: the app has no sign-up, and one deleted since the link was sent isn't made again.
  if (!link || !(await prisma.user.findUnique({ where: { email: link.email }, select: { id: true } }))) {
    return to(`${back}&error=INVALID_TOKEN`);
  }
  // Better Auth uses the token up (once, if still fresh) and answers with the redirect; used up since the check, its
  // redirect has `error`, as above.
  const response = await auth.api.magicLinkVerify({ query: { token, callbackURL: back }, headers: request.headers, asResponse: true });
  return to(response.headers.get("location") ?? `${back}&error=INVALID_TOKEN`);
}
