import type { CoverDesign } from "@/server/cover-card";
import { MAX_COVER_HEADLINE } from "@/server/operations/covers";
import { cookieCaller, unlessRefused } from "@/server/trpc/server";

/**
 * A changelog entry's cover in one design (changelog.cover), drawn for the team to pick from: the saved entry's own
 * title (or `?headline=`), tag, headings and image with the portal's branding, at half the stored cover's size.
 * Nothing is stored. Only the project's team gets one, as on the entry's page; a design with nothing to show for this
 * entry (Screenshot without an image) isn't there.
 */
export async function GET(request: Request, context: RouteContext<"/app/[project]/changelog/[number]/cover/[design]">) {
  const { project, number, design } = await context.params;
  // A design that isn't one, like a number that isn't, is refused by the router's input.
  if (!/^\d{1,9}$/.test(number)) {
    return notFound();
  }
  // As typed, however long: the drawing cuts a long one short with an ellipsis, as it does a long title (kept to a size worth reading).
  const headline = new URL(request.url).searchParams.get("headline")?.slice(0, MAX_COVER_HEADLINE * 4);
  const cover = await unlessRefused((await cookieCaller()).changelog.cover({ project, number: Number(number), design: design as CoverDesign, headline }));
  // Drawn from what's saved now: never kept, so a save or a new logo shows the next time it's asked for.
  return cover ? new Response(new Uint8Array(Buffer.from(cover.png, "base64")), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } }) : notFound();
}

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
