import { log } from "@tuti/shared";

import { applyAppsumoEvent, appsumoSigned, readAppsumoEvent, UnknownTier } from "@/server/appsumo";

/**
 * AppSumo's licensing webhook (server/appsumo.ts), on with APPSUMO_API_KEY: only events it signed in the last 5 minutes
 * are read. Each is answered `{ event, success: true }` once applied (test events change nothing), which AppSumo waits
 * for before it marks a license active or deactivated; anything else, and it tries again.
 */
export async function POST(request: Request) {
  const key = process.env.APPSUMO_API_KEY;
  if (!key) {
    return new Response(null, { status: 404 });
  }
  const body = await request.text();
  if (!appsumoSigned(body, request.headers.get("x-appsumo-timestamp"), request.headers.get("x-appsumo-signature"), key)) {
    return Response.json({ success: false, error: "Bad signature" }, { status: 401 });
  }
  const event = readAppsumoEvent(body, request.headers.get("content-type"));
  if (!event) {
    return Response.json({ success: false, error: "Not an event" }, { status: 400 });
  }
  try {
    await applyAppsumoEvent(event);
  } catch (error) {
    if (error instanceof UnknownTier) {
      log.error(error.message, { event: event.event });
      return Response.json({ event: event.event, success: false, error: "Unknown tier" }, { status: 500 });
    }
    throw error;
  }
  return Response.json({ event: event.event, success: true });
}
