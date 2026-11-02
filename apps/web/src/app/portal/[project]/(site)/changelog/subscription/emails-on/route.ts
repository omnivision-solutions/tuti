import { projectEmailWaits } from "@tuti/jobs";
import { NextResponse } from "next/server";

import { emailConfirmation, findSubscription } from "@/server/changelog-subscription";
import { countEmailedLink } from "@/server/email-link-limits";
import { portalHref } from "@/server/portal-base";

/**
 * "Email me a link" on a confirmed subscription's page, for someone who turned all of the project's emails off (which
 * wins over the changelog): emails the address a fresh confirmation link, whose page turns them back on. The
 * subscription's own token is long-lived (forwarded emails have it), so it never turns them on itself. Counted with
 * the other emailed links' limits. Only where it could do something: a public portal (a private one emails nobody), and
 * an address that's turned them off (anyone holding the token could otherwise have links sent at will); nothing while
 * the project's email is paused.
 */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/changelog/subscription/emails-on">) {
  const { project } = await params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const found = await findSubscription(project, token);
  if (!found?.confirmedAt) {
    return new NextResponse("This link doesn't work.", { status: 404 });
  }
  if (found.reach === "private") {
    return new NextResponse("Updates by email aren't available here.", { status: 403 });
  }
  // Nothing to turn back on (changelogReach), so nothing is sent; the page says where they stand.
  const back = await portalHref(`/changelog/subscription?token=${encodeURIComponent(token)}`);
  if (found.reach !== "opted-out") {
    return new NextResponse(null, { status: 303, headers: { location: back } });
  }
  if (await projectEmailWaits(found.projectId)) {
    return new NextResponse("Emails from here are paused for now. Try again later.", { status: 503 });
  }
  const limited = await countEmailedLink(found.projectId, found.email, request.headers);
  if ("error" in limited) {
    return new NextResponse(limited.error, { status: 429 });
  }
  // Over the visitor's limit: nothing is sent, but the page says the same.
  if (limited.id) {
    const sent = await emailConfirmation({ id: found.projectId, name: found.project.name, slug: found.project.slug }, found);
    if (sent.error) {
      return new NextResponse(sent.error, { status: 502 });
    }
  }
  // Relative, so it stays on the portal's host (the request URL is the rewritten /portal one), under its site's path if it has one.
  return new NextResponse(null, { status: 303, headers: { location: `${back}&sent=1` } });
}
