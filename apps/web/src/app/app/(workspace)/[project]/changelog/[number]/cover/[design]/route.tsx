import { prisma } from "@tuti/db";

import { COVER_DESIGNS, COVER_SIZE, type CoverDesign, coverContent, coverDesigns, drawCover, MAX_COVER_HEADLINE } from "@/server/cover-card";
import { getMembership } from "@/server/membership";
import { branding } from "@/server/operations/branding";

/**
 * A changelog entry's cover in one design (server/cover-card.tsx), drawn for the team to pick from: the saved entry's
 * own title (or `?headline=`), tag, headings and image with the portal's branding, at half the stored cover's size.
 * Nothing is stored. Only the project's team gets one, as on the entry's page; a design with nothing to show for this
 * entry (Screenshot without an image) isn't there.
 */
export async function GET(request: Request, context: RouteContext<"/app/[project]/changelog/[number]/cover/[design]">) {
  const { project: slug, number, design } = await context.params;
  const membership = await getMembership(slug);
  if (!membership || !/^\d{1,9}$/.test(number) || !(COVER_DESIGNS as readonly string[]).includes(design)) {
    return notFound();
  }
  const { project } = membership;
  const [entry, brand] = await Promise.all([
    prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId: project.id, number: Number(number) } }, select: { title: true, tags: true, content: true, body: true } }),
    branding({ id: project.id }),
  ]);
  if (!entry || !brand) {
    return notFound();
  }
  // As typed, however long: the drawing cuts a long one short with an ellipsis, as it does a long title (kept to a size worth reading).
  const headline = new URL(request.url).searchParams.get("headline")?.slice(0, MAX_COVER_HEADLINE * 4);
  const content = await coverContent(project.id, entry, headline);
  if (!coverDesigns(content).includes(design as CoverDesign)) {
    return notFound();
  }
  const png = await drawCover({ project, brand }, content, design as CoverDesign, COVER_SIZE.width / 2);
  // Drawn from what's saved now: never kept, so a save or a new logo shows the next time it's asked for.
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } });
}

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
