import type { CoverDesign } from "@/server/cover-card";
import { cookieCaller, unlessRefused } from "@/server/trpc/server";

/**
 * A cover design as Settings → Changelog shows it to pick from (changelogStyle.cover): a sample entry (a title, a tag,
 * three headings and a made-up screenshot) with the portal's own branding, at half the stored cover's size.
 * `?background=`: an image of this project's, uploaded and not saved yet, for Your background; without it, the one
 * saved. Nothing is stored. Owners and admins only, as the page is.
 */
export async function GET(request: Request, context: RouteContext<"/app/[project]/settings/changelog/cover/[design]">) {
  const { project, design } = await context.params;
  // A design that isn't one is refused by the router's input.
  const background = new URL(request.url).searchParams.get("background") ?? undefined;
  const cover = await unlessRefused((await cookieCaller()).changelogStyle.cover({ project, design: design as CoverDesign, background }));
  return cover ? new Response(new Uint8Array(Buffer.from(cover.png, "base64")), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } }) : notFound();
}

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
