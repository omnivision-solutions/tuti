import { prisma } from "@tuti/db";

import { SLUG_PATTERN } from "@/lib/project-slugs";
import { verifySsoToken } from "@/lib/sso";
import { changelogSeenAt, markChangelogSeen } from "@/server/operations/changelog-seen";
import { OperationError } from "@/server/operations/define";
import { call } from "@/server/operations/run";

/**
 * What's new per person, for the widget script on customers' sites when the page signs
 * its users in (Tuti.identify): GET says up to when this person has seen the project's
 * announcements, on any device; POST `{ at }` records that they've seen them up to `at`
 * (it never moves back). The script only calls it when this browser hasn't seen the
 * latest announcement, or after the panel showed it.
 *
 * Signed in with a fresh SSO token from the customer's app as a bearer token (checked like
 * /sso: signature, lifetime, single use), never cookies, so any site may call it; the
 * answer is this person's, so it's never cached.
 */
const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };

async function signedIn(request: Request) {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const token = /^Bearer (\S{1,8192})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!SLUG_PATTERN.test(slug) || !token) {
    return null;
  }
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, ssoSecret: true } });
  if (!project?.ssoSecret) {
    return null;
  }
  const verified = await verifySsoToken({ id: project.id, ssoSecret: project.ssoSecret }, token);
  return "error" in verified ? null : { actor: { kind: "user" as const, userId: verified.userId }, projectId: project.id };
}

const refused = () => Response.json({ error: "Sign in with a fresh token from your app" }, { status: 401, headers });

export async function GET(request: Request) {
  const context = await signedIn(request);
  if (!context) {
    return refused();
  }
  const seen = await changelogSeenAt(context.projectId, context.actor.userId);
  return Response.json({ seen: seen?.toISOString() ?? null }, { headers });
}

export async function POST(request: Request) {
  const context = await signedIn(request);
  if (!context) {
    return refused();
  }
  const body = (await request.json().catch(() => null)) as { at?: unknown } | null;
  try {
    const { seenAt } = await call(markChangelogSeen, context, { at: body?.at as string | undefined });
    return Response.json({ seen: seenAt }, { headers });
  } catch (error) {
    if (error instanceof OperationError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    throw error;
  }
}

/** CORS preflight: the bearer token makes every call one. */
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "86400",
    },
  });
}
