import { prisma } from "@tuti/db";

import { auth } from "@/lib/auth";
import { hashSecret } from "@/lib/portal-handoff";
import { safeRedirectPath } from "@/lib/redirects";

const FAILED = "/sign-in?link=failed";

/**
 * <project>.tuti.so/sign-in/link?token=…&next=… is the link in a sign-in email
 * (lib/sign-in-link.ts). It only works on the portal that sent it, once, while
 * it's fresh; it signs the person in on this portal (making their account if
 * it's new) and goes back to `next`.
 */
export async function GET(request: Request, { params }: RouteContext<"/portal/[project]/sign-in/link">) {
  const { project } = await params;
  const query = new URL(request.url).searchParams;
  const token = query.get("token") ?? "";
  const link =
    token && token.length <= 100
      ? await prisma.signInLink.findUnique({ where: { tokenHash: hashSecret(token) }, select: { project: { select: { slug: true } } } })
      : null;
  if (link?.project.slug !== project) {
    return new Response(null, { status: 303, headers: { location: FAILED } });
  }
  // Better Auth uses the token up, makes the account if needed and sets this host's session cookie.
  return auth.api.magicLinkVerify({
    query: { token, callbackURL: safeRedirectPath(query.get("next") ?? undefined, "/"), errorCallbackURL: FAILED },
    headers: request.headers,
    asResponse: true,
  });
}
