import { isMediaId } from "@tuti/content";
import { prisma } from "@tuti/db";
import { mediaStorage, SIGNED_WINDOW_SECONDS } from "@tuti/shared/storage";

import { verifyForever } from "@/lib/signed";

const gone = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

/**
 * A lasting link to an image (server/media-urls.ts `lastingMediaUrl`), from an email, a
 * link card or an export: sends the reader on to a fresh presigned URL while the image is
 * in use, and is gone once it isn't. The file itself never comes from the app's host.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const key = `m/${id}/${file}`;
  const storage = mediaStorage();
  if (!storage || !isMediaId(id) || !verifyForever("media", key, new URL(request.url).searchParams.get("s") ?? "")) {
    return gone();
  }
  const media = await prisma.media.findFirst({ where: { id, status: "READY", attachedAt: { not: null } }, select: { id: true } });
  if (!media) {
    return gone();
  }
  return new Response(null, {
    status: 302,
    // The URL it points to works for at least a window, so the browser may keep the redirect that long.
    headers: { location: await storage.signedUrl(key), "cache-control": `private, max-age=${SIGNED_WINDOW_SECONDS}` },
  });
}
