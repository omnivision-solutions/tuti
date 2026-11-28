import { inboxStream } from "@/server/live";
import { ContextError, requestContext } from "@/server/trpc/context";
import { createCaller, unlessRefused } from "@/server/trpc/server";
import { hears } from "@/server/widget-person";

/**
 * The widget's live updates for someone's Messages (`?project=<slug>`; server/live.ts): only their own
 * conversations. Who they are comes in a header, never the URL, as /api/trpc reads it (server/trpc/context.ts):
 * `Authorization: Widget <token>` for someone the page signed in, `Visitor <token>` for a signed-out visitor, or
 * neither for someone signed in on the portal itself (its cookie). Who may hear is the router's (live.widget), asked as
 * the stream opens and at each keepalive: it ends when that token or session does; the panel closes it when the page
 * signs someone else in or out.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const who = await listening(request, slug);
  if (!who) {
    return new Response("Sign in to message the team", { status: 401 });
  }
  return inboxStream(request, {
    wants: (change) => hears(who, change),
    // Still them: the same person, by the same token or session (read without extending it: an open panel mustn't keep
    // a session from ever ending).
    stillAllowed: async () => {
      const now = await listening(request, slug, { refresh: false });
      return !!now && now.userId === who.userId && now.visitorHash === who.visitorHash;
    },
  });
}

/** Who hears the project's Messages on this request (live.widget), or null where the router refuses them. */
async function listening(request: Request, slug: string, read: { refresh?: boolean } = {}) {
  let context;
  try {
    context = await requestContext(request.headers, read);
  } catch (error) {
    if (error instanceof ContextError) {
      return null;
    }
    throw error;
  }
  return unlessRefused(createCaller(context).live.widget({ project: slug }));
}
