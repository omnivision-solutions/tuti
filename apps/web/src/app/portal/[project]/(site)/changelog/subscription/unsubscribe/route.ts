import { NextResponse } from "next/server";

import { findSubscription } from "@/server/changelog-subscription";
import { portalHref } from "@/server/portal-base";

/**
 * Stops a changelog subscription's emails. Mail apps POST here straight from the List-Unsubscribe header (one
 * click, RFC 8058); the subscription page's button posts here too and goes back to the page. A POST, so link
 * scanners can't unsubscribe anyone.
 */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/changelog/subscription/unsubscribe">) {
  const { project } = await params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const found = await findSubscription(project, token);
  if (!found) {
    return new NextResponse("This unsubscribe link doesn't work.", { status: 404 });
  }
  await found.unsubscribe();
  const form = await request.formData().catch(() => null);
  if (form?.get("List-Unsubscribe") === "One-Click") {
    return new NextResponse("Unsubscribed.");
  }
  // Relative, so it stays on the portal's host (the request URL is the rewritten /portal one), under its site's path if it has one.
  const location = await portalHref(`/changelog/subscription?token=${encodeURIComponent(token)}`);
  return new NextResponse(null, { status: 303, headers: { location } });
}
