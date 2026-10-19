import { NextResponse } from "next/server";

import { findOptOut } from "@/server/unsubscribe";

/**
 * Stops a project's emails to someone. Mail apps POST here straight from the
 * List-Unsubscribe header (one click, RFC 8058); the unsubscribe page's button
 * posts here too and goes back to the page. A POST, so link scanners can't unsubscribe anyone.
 */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/unsubscribe/confirm">) {
  const { project } = await params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const found = await findOptOut(project, token);
  if (!found) {
    return new NextResponse("This unsubscribe link doesn't work.", { status: 404 });
  }
  await found.optOut();
  const form = await request.formData().catch(() => null);
  if (form?.get("List-Unsubscribe") === "One-Click") {
    return new NextResponse("Unsubscribed.");
  }
  // Relative, so it stays on the portal's host (the request URL is the rewritten /portal one).
  return new NextResponse(null, { status: 303, headers: { location: `/unsubscribe?token=${encodeURIComponent(token)}` } });
}
