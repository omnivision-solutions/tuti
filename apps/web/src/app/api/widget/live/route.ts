import { prisma } from "@tuti/db";

import { visitorHash } from "@/lib/visitor-session";
import { widgetUser } from "@/lib/widget-session";
import { inboxStream } from "@/server/live";
import { presenceKey, touchPresence } from "@/server/presence";
import { getSession } from "@/server/session";
import { widgetPerson } from "@/server/widget-person";

/**
 * The widget's live updates for someone's Messages (`?project=<slug>`; server/live.ts): only their own
 * conversations. Who they are comes in a header, never the URL: `Authorization: Widget <token>` for
 * someone the page signed in, `Visitor <token>` for a signed-out visitor, or neither for someone signed
 * in on the portal itself (its cookie). Ends when that token or session does; the panel closes it when
 * the page signs someone else in or out.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const [, kind, token] = /^(Widget|Visitor) (\S{1,8192})$/.exec(request.headers.get("authorization") ?? "") ?? [];
  const who = await widgetPerson(slug, { token: kind === "Widget" ? token : null, visitor: kind === "Visitor" ? token : null });
  if (!who) {
    return new Response("Sign in to message the team", { status: 401 });
  }
  const session = kind ? null : await getSession();
  const { projectId } = who;
  // Online while it's open: each check below counts as being here (written at most once a minute).
  const here = () => touchPresence(projectId, presenceKey(who));
  await here();
  return inboxStream(request, {
    wants: (change) =>
      change.projectId === projectId && (who.userId ? change.userId === who.userId : change.visitorHash === who.visitorHash),
    stillAllowed: async () => {
      const allowed =
        kind === "Widget"
          ? widgetUser(projectId, token!) !== null
          : kind === "Visitor"
            ? visitorHash(projectId, token!) !== null
            : !!session && (await prisma.session.count({ where: { id: session.session.id, expiresAt: { gt: new Date() } } })) > 0;
      if (allowed) {
        await here();
      }
      return allowed;
    },
  });
}
