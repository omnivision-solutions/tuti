import { NextResponse } from "next/server";

import { findSubscription } from "@/server/changelog-subscription";

/** Confirms a changelog subscription (the confirmation email's link, then its page's button) and goes back to the page. */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/changelog/subscription/confirm">) {
  const { project } = await params;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const found = await findSubscription(project, token);
  if (!found) {
    return new NextResponse("This link doesn't work.", { status: 404 });
  }
  await found.confirm();
  // Relative, so it stays on the portal's host (the request URL is the rewritten /portal one).
  return new NextResponse(null, { status: 303, headers: { location: `/changelog/subscription?token=${encodeURIComponent(token)}` } });
}
