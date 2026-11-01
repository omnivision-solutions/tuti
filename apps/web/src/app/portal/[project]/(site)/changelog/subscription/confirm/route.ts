import { NextResponse } from "next/server";

import { findSubscription } from "@/server/changelog-subscription";
import { portalHref } from "@/server/portal-base";

/** Confirms a changelog subscription (the confirmation email's link, then its page's button) and goes back to the page. */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/changelog/subscription/confirm">) {
  const { project } = await params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const found = await findSubscription(project, token);
  if (!found) {
    return new NextResponse("This link doesn't work.", { status: 404 });
  }
  // A private portal emails nobody: the page says so (and only offers Unsubscribe).
  if (found.project.portalAccess !== "PUBLIC") {
    return new NextResponse("Updates by email aren't available here.", { status: 403 });
  }
  await found.confirm();
  // Relative, so it stays on the portal's host (the request URL is the rewritten /portal one), under its site's path if it has one.
  const location = await portalHref(`/changelog/subscription?token=${encodeURIComponent(token)}`);
  return new NextResponse(null, { status: 303, headers: { location } });
}
