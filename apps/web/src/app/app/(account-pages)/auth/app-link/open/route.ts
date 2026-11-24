import { appSignInReturn, isAppSignInState } from "@/lib/app-sign-in";
import { auth } from "@/lib/auth";
import { requestTarget } from "@/server/custom-domains";
import { pendingSignInLink } from "@/server/sign-in-link-lookup";

/**
 * "Open the app" on the page the mobile app's sign-in link opens (/app/auth/app-link, lib/app-sign-in.ts): uses the
 * token up, starts a session for the account and redirects the browser to the app, through its link scheme, with the
 * session's cookie for it to keep and the `state` the app asked with. A dead link tells the app `error` instead. A
 * form's post answered with a redirect, as a provider's sign-in ends: the way browsers open an app, with nothing for a
 * script to do. The session is the app's alone (lib/app-sign-in.ts takes its cookie out of the answer): this browser,
 * which may be anyone's (a link opened at a desk), stays as it was, signed in or not. Not the app's host, or no state of
 * the app's: back to the page, which says the link doesn't work.
 */
export async function POST(request: Request) {
  const to = (location: string) => new Response(null, { status: 303, headers: { location } });
  const form = await request.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  const state = form?.get("state");
  if (!isAppSignInState(state) || (await requestTarget(request.headers.get("host"))).kind !== "app") {
    return to("/app/auth/app-link");
  }
  const back = appSignInReturn(state);
  if (!(await pendingSignInLink(null, token))) {
    return to(`${back}&error=INVALID_TOKEN`);
  }
  // Better Auth uses the token up (once, if still fresh) and answers with the redirect; used up since the check, its
  // redirect has `error`, as above.
  const response = await auth.api.magicLinkVerify({ query: { token, callbackURL: back }, headers: request.headers, asResponse: true });
  return to(response.headers.get("location") ?? `${back}&error=INVALID_TOKEN`);
}
