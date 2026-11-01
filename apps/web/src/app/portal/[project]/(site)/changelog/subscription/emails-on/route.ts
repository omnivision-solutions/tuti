import { NextResponse } from "next/server";

import { findSubscription } from "@/server/changelog-subscription";
import { portalHref } from "@/server/portal-base";

/**
 * "Turn Acme's emails back on" on a confirmed subscription's page: someone who turned all of the project's emails off
 * (which wins over the changelog) turns them on again, and goes back to the page.
 */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/changelog/subscription/emails-on">) {
  const { project } = await params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const found = await findSubscription(project, token);
  if (!found?.confirmedAt) {
    return new NextResponse("This link doesn't work.", { status: 404 });
  }
  await found.turnEmailsOn();
  // Relative, so it stays on the portal's host (the request URL is the rewritten /portal one), under its site's path if it has one.
  const location = await portalHref(`/changelog/subscription?token=${encodeURIComponent(token)}`);
  return new NextResponse(null, { status: 303, headers: { location } });
}
