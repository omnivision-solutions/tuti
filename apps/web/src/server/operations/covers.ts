import { prisma } from "@tuti/db";
import { mediaStorage } from "@tuti/shared/storage";
import sharp from "sharp";
import { z } from "zod";

import { COVER_DESIGNS, COVER_SIZE, type CoverContent, coverContent, coverDesigns, drawCover, MAX_COVER_HEADLINE } from "../cover-card";
import { branding } from "./branding";
import { defineOperation, OperationError } from "./define";

/**
 * Covers drawn for the team to pick from (server/cover-card.tsx), at half the stored cover's size, as a PNG (base64):
 * the app's `cover/[design]` routes serve them. Nothing is stored, and each is drawn from what's saved now.
 */

/** For the routes: what they check before asking. */
export { MAX_COVER_HEADLINE };

const picture = z.object({ png: z.string().describe("The cover as a PNG, base64") });
const missing = () => new OperationError(404, "not_found", "No such cover");

/** An entry's cover in one design: its own title (or `headline`), tag, headings and image with the portal's branding. */
export const getChangelogCover = defineOperation({
  name: "changelog.cover",
  title: "Draw an entry's cover",
  summary: "A changelog entry's cover in one design, to pick from.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  errors: [404],
  input: z.object({
    number: z.number().int().positive(),
    design: z.enum(COVER_DESIGNS),
    // As typed, however long: the drawing cuts a long one short with an ellipsis, as it does a long title.
    headline: z.string().max(MAX_COVER_HEADLINE * 4).optional(),
  }),
  output: picture,
  run: async ({ projectId }, { number, design, headline }) => {
    const [entry, brand, project] = await Promise.all([
      prisma.changelogEntry.findUnique({ where: { projectId_number: { projectId, number } }, select: { title: true, tags: true, content: true, body: true } }),
      branding({ id: projectId }),
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
    ]);
    if (!entry || !brand) {
      throw missing();
    }
    const content = await coverContent(projectId, entry, headline);
    // A design with nothing to show for this entry (Screenshot without an image) isn't there.
    if (!coverDesigns(content).includes(design)) {
      throw missing();
    }
    const png = await drawCover({ project, brand }, content, design, COVER_SIZE.width / 2);
    return { png: png.toString("base64") };
  },
});

/**
 * A design as Settings → Changelog shows it: a sample entry with the portal's own branding. `background`: an image of
 * this project's, uploaded and not saved yet, for Your background; without it, the one saved. Owners and admins, as the page.
 */
export const getChangelogStyleCover = defineOperation({
  name: "changelogStyle.cover",
  title: "Draw a sample cover",
  summary: "A cover design on a sample entry, as Settings → Changelog shows it.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "admin",
  errors: [404],
  input: z.object({ design: z.enum(COVER_DESIGNS), background: z.string().min(1).max(100).optional() }),
  output: picture,
  run: async ({ projectId }, { design, background: given }) => {
    const background = design === "background" && mediaStorage() ? await backgroundOf(projectId, given ?? null) : null;
    const [brand, project] = await Promise.all([branding({ id: projectId }), prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } })]);
    if (!brand || (design === "background" && !background)) {
      throw missing();
    }
    const content: CoverContent = { title: `What's new in ${project.name}`, tag: "New", headings: ["Faster search", "Dark mode", "Fixes"], image: null, background, preferred: null };
    const png = await drawCover({ project, brand }, content, design, COVER_SIZE.width / 2, { screenshot: design === "screenshot" ? await sampleScreenshot() : undefined });
    return { png: png.toString("base64") };
  },
});

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
