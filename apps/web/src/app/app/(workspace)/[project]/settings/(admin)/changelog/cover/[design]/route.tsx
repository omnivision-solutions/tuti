import { prisma } from "@tuti/db";
import { mediaStorage } from "@tuti/shared/storage";
import sharp from "sharp";

import { COVER_DESIGNS, COVER_SIZE, type CoverContent, type CoverDesign, drawCover } from "@/server/cover-card";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

/**
 * A cover design as Settings → Changelog shows it to pick from: a sample entry (a title, a tag, three headings and a
 * made-up screenshot) with the portal's own branding, at half the stored cover's size. `?background=`: an image
 * of this project's, uploaded and not saved yet, for Your background; without it, the one saved. Nothing is stored.
 * Owners and admins only, as the page is.
 */
export async function GET(request: Request, context: RouteContext<"/app/[project]/settings/changelog/cover/[design]">) {
  const { project: slug, design } = await context.params;
  const project = await getAdminProject(slug);
  if (!project || !(COVER_DESIGNS as readonly string[]).includes(design)) {
    return notFound();
  }
  const background = design === "background" && mediaStorage() ? await backgroundOf(project.id, new URL(request.url).searchParams.get("background")) : null;
  const brand = await branding({ id: project.id });
  if (!brand || (design === "background" && !background)) {
    return notFound();
  }
  const content: CoverContent = { title: `What's new in ${project.name}`, tag: "New", headings: ["Faster search", "Dark mode", "Fixes"], image: null, background, preferred: null };
  const png = await drawCover({ project, brand }, content, design as CoverDesign, COVER_SIZE.width / 2, { screenshot: design === "screenshot" ? await sampleScreenshot() : undefined });
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } });
}

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });

/** The image for Your background: the one given (this project's, ready), else the one saved. */
async function backgroundOf(projectId: string, given: string | null) {
  const id = given ?? (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { changelogCoverBackgroundId: true } })).changelogCoverBackgroundId;
  const image = id && (await prisma.media.findFirst({ where: { id, projectId, status: "READY" }, select: { id: true, width: true, height: true } }));
  return image && image.width && image.height ? { id: image.id, width: image.width, height: image.height } : null;
}

/** Screenshot's sample picture: an app's window in greys, a sidebar and lines of text. */
async function sampleScreenshot() {
  const lines = [180, 230, 280, 360, 410, 460].map((y, index) => `<rect x="312" y="${y}" width="${index % 3 === 2 ? 420 : 740}" height="22" rx="8" fill="#e4e4e7"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720"><rect width="1100" height="720" rx="24" fill="#f4f4f5"/><rect width="1100" height="64" rx="24" fill="#e4e4e7"/><rect y="40" width="1100" height="24" fill="#e4e4e7"/><rect x="32" y="104" width="240" height="584" rx="16" fill="#e4e4e7"/><rect x="312" y="104" width="520" height="36" rx="10" fill="#d4d4d8"/>${lines}<rect x="312" y="540" width="200" height="56" rx="14" fill="#a1a1aa"/></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { src: `data:image/png;base64,${png.toString("base64")}`, width: 1100, height: 720 };
}
