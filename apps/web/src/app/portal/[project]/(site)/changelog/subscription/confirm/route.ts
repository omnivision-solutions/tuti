import { NextResponse } from "next/server";

import { findConfirmation } from "@/server/changelog-subscription";
import { portalHref } from "@/server/portal-base";

/**
 * Confirms a changelog subscription with the request's own link (the confirmation email's, then its page's button),
 * once, and goes to the subscription's page. A link replaced by a newer request, used, expired or from before an
 * unsubscribe confirms nothing.
 */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/changelog/subscription/confirm">) {
  const { project } = await params;
  const confirm = new URL(request.url).searchParams.get("confirm") ?? "";
  const found = await findConfirmation(project, confirm);
  if (!found) {
    return new NextResponse("This link doesn't work any more.", { status: 404 });
  }
  // A private portal emails nobody: the page says so (and offers nothing to confirm).
  if (found.project.portalAccess !== "PUBLIC") {
    return new NextResponse("Updates by email aren't available here.", { status: 403 });
  }
  if (!(await found.confirm())) {
    return new NextResponse("This link doesn't work any more.", { status: 404 });
  }
  // Relative, so it stays on the portal's host (the request URL is the rewritten /portal one), under its site's path if it has one.
  const location = await portalHref(`/changelog/subscription?token=${encodeURIComponent(found.token)}`);
  return new NextResponse(null, { status: 303, headers: { location } });
}
