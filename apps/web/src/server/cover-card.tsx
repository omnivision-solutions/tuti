import { type Doc, toPlainText } from "@tuti/content";
import { imageKey, imageWidths } from "@tuti/content/media";
import { type ChangelogTag, prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { luminance, readableOn } from "@tuti/shared/colors";
import { mediaStorage } from "@tuti/shared/storage";
import satori from "satori";
import sharp from "sharp";

import { TAG_LABELS } from "@/components/changelog-tag";
import { displayDoc } from "@/server/content";
import type { Branding } from "@/server/operations/branding";

import { drawable, fonts, logoImage, oneLine, THEMES, TUTI_GREEN } from "./share-card";

/**
 * A changelog entry's cover, composed from what the entry and the portal's branding already have (no image model): its
 * title, its first tag, its headings and its first image, with the portal's logo, colour and look. Drawn as the link
 * cards are (share-card.tsx), in the shape the editor asks covers to have and link previews show (1200×630, here at
 * 1600). The widget's cards crop a cover to 2:1, 20px off its top and bottom: every design keeps its text clear of that.
 */
export const COVER_SIZE = { width: 1600, height: 840 } as const;

/** The designs, in the order they're offered. */
export const COVER_DESIGNS = ["title", "screenshot", "sections", "pattern", "background"] as const;
export type CoverDesign = (typeof COVER_DESIGNS)[number];

export type CoverContent = {
  /** The entry's title, or the headline given in its place. */
  title: string;
  /** Its first tag as readers see it ("New"); null without one. */
  tag: string | null;
  /** Its headings, in order. */
  headings: string[];
  /** Its first image big enough to show off (this project's, processed); null without one. */
  image: Image | null;
  /** The team's own background (Settings → Changelog), for the Your background design; null without one. */
  background: Image | null;
  /** The design the team picks first (Settings → Changelog); null for the automatic pick. */
  preferred: CoverDesign | null;
};

type Image = { id: string; width: number; height: number };

type Site = { project: { name: string }; brand: Branding };
type Logo = Awaited<ReturnType<typeof logoImage>>;
export type Picture = { src: string; width: number; height: number } | null;

/**
 * The most of a title a cover draws: a longer one is cut there with an ellipsis, so it's also the longest headline to
 * give in its place. The widest design (Title) shows that much whole; the narrower ones end a long title with an
 * ellipsis at their third line.
 */
export const MAX_COVER_HEADLINE = 90;

/** Narrower than this, an image is an icon or a badge, not something to build a cover on. */
const MIN_PICTURE_WIDTH = 600;

/** What a cover is made of, for an entry as it's saved. `headline` stands in for its title. */
export async function coverContent(
  projectId: string,
  entry: { title: string; tags: ChangelogTag[]; content: unknown; body: string },
  headline?: string,
): Promise<CoverContent> {
  const doc = displayDoc(entry);
  const { changelogCoverDesign, changelogCoverBackground: background } = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { changelogCoverDesign: true, changelogCoverBackground: { select: { id: true, status: true, width: true, height: true } } },
  });
  const headings = (doc.content ?? []).filter((node) => node.type === "heading").map((node) => drawable(toPlainText(node))).filter(Boolean);
  const ids = imageIds(doc);
  const images = ids.length
    ? await prisma.media.findMany({ where: { id: { in: ids }, projectId, status: "READY", width: { gte: MIN_PICTURE_WIDTH }, height: { not: null } }, select: { id: true, width: true, height: true } })
    : [];
  const first = ids.map((id) => images.find((image) => image.id === id)).find((image) => image !== undefined);
  return {
    title: headline?.trim() || entry.title,
    tag: entry.tags[0] ? TAG_LABELS[entry.tags[0]] : null,
    headings,
    // Without uploads there's nothing to read it from.
    image: first && mediaStorage() ? { id: first.id, width: first.width!, height: first.height! } : null,
    background:
      background?.status === "READY" && background.width && background.height && mediaStorage() ? { id: background.id, width: background.width, height: background.height } : null,
    preferred: (COVER_DESIGNS as readonly string[]).includes(changelogCoverDesign) ? (changelogCoverDesign as CoverDesign) : null,
  };
}

/** The images' uploads, in the order they come in the text. */
function imageIds(node: NonNullable<Doc["content"]>[number] | Doc): string[] {
  const own = node.type === "image" && typeof node.attrs?.mediaId === "string" ? [node.attrs.mediaId] : [];
  return [...own, ...(node.content ?? []).flatMap(imageIds)];
}

/** The designs with something to show for this entry: Screenshot needs an image, Sections two headings, Your background the team's. */
export const coverDesigns = (content: Pick<CoverContent, "headings" | "image" | "background">): CoverDesign[] =>
  COVER_DESIGNS.filter((design) =>
    design === "screenshot" ? content.image !== null : design === "sections" ? content.headings.length >= 2 : design === "background" ? content.background !== null : true,
  );

/**
 * The design picked when nobody picks: the team's own pick where the entry has something to show in it, else the
 * entry's image where it has one, else its title on the portal's colour.
 */
export const automaticDesign = (content: Pick<CoverContent, "headings" | "image" | "background" | "preferred">): CoverDesign =>
  content.preferred && coverDesigns(content).includes(content.preferred) ? content.preferred : content.image ? "screenshot" : "title";

/** The entry's image (or the team's background) couldn't be read for the design it was asked for by name (storage's own trouble: try again). */
export class CoverPictureUnread extends Error {}

/**
 * The cover as a PNG, `width` pixels wide (the stored one at its full size, a preview smaller). `asAsked`: the design
 * was asked for by name, so Screenshot whose image can't be read is refused (CoverPictureUnread) rather than drawn as
 * another design. `screenshot`: a picture to draw in Screenshot's frame instead of the entry's image (Settings' sample).
 */
export async function drawCover(
  site: Site,
  content: CoverContent,
  design: CoverDesign,
  width: number = COVER_SIZE.width,
  { asAsked = false, screenshot }: { asAsked?: boolean; screenshot?: Picture } = {},
): Promise<Buffer> {
  const dark = site.brand.colorScheme === "dark";
  const pictured = design === "screenshot" || design === "background";
  const [logo, picture] = await Promise.all([
    logoImage(dark ? (site.brand.logoDark ?? site.brand.logo) : site.brand.logo),
    design === "screenshot" ? (screenshot ?? pictureOf(content.image)) : design === "background" ? pictureOf(content.background, true) : null,
  ]);
  if (pictured && !picture && asAsked) {
    throw new CoverPictureUnread();
  }
  // Its image can't be read after all: the title's design, not a frame with nothing in it.
  const drawn = pictured && !picture ? "title" : design;
  const svg = await satori(coverElement(site, content, drawn, logo, picture), { ...COVER_SIZE, fonts: await fonts() });
  return sharp(Buffer.from(svg)).resize(width).png().toBuffer();
}

/**
 * The entry's image as a PNG (the renderer can't read the stored WebP), no wider than its frame needs; `filling`: the
 * team's background, cropped to fill the cover.
 */
async function pictureOf(image: Image | null, filling = false): Promise<Picture> {
  const storage = mediaStorage();
  if (!image || !storage) {
    return null;
  }
  try {
    const stored = imageWidths(image.width).find((width) => width >= (filling ? COVER_SIZE.width : 960)) ?? image.width;
    const read = sharp(await storage.get(imageKey(image.id, stored)));
    const png = await (filling ? read.resize(COVER_SIZE.width, COVER_SIZE.height, { fit: "cover" }) : read.resize(1100, 1100, { fit: "inside", withoutEnlargement: true })).png().toBuffer();
    return { src: `data:image/png;base64,${png.toString("base64")}`, ...(filling ? COVER_SIZE : { width: image.width, height: image.height }) };
  } catch (error) {
    log.warn("Couldn't read an image for a cover", { mediaId: image.id, error });
    return null;
  }
}

/** The link card's sizes (a 1200 canvas) on the cover's. */
const SCALE = COVER_SIZE.width / 1200;

const root = { width: "100%", height: "100%", display: "flex", position: "relative", overflow: "hidden", fontFamily: "Figtree" } as const;
/**
 * The text's side: the logo at its top, the title at its foot. A width of its own, in a row: the renderer measures a
 * wrapped title's height by it (as the canvas's own column, a title's second line ran off the bottom edge). The width
 * is the text's: the renderer adds the padding to it.
 */
const column = { display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "84px 0 84px 96px" } as const;

export function coverElement(site: Site, content: CoverContent, design: CoverDesign, logo: Logo, picture: Picture) {
  const theme = THEMES[site.brand.colorScheme === "dark" ? "dark" : "light"];
  const color = site.brand.color ?? TUTI_GREEN;
  // On the portal's colour: white where a big bold title reads on it (3:1), else near-black (a yellow, a pale tint).
  const pale = luminance(color) > 0.3;
  const on = pale ? "#1c1917" : "#ffffff";
  const ink = pale ? "rgba(28,25,23," : "rgba(255,255,255,";
  // The colour as text and shapes on the page: the nearest shade of it that reads there, else the text colour.
  const accent = readableOn(color, theme.surface, 3) ?? theme.text;
  // The tag is small: on the page, the colour's shade that reads as text (4.5:1); on the colour, the page's own colours,
  // as the logo's chip (white on a mid colour reads for the big title only).
  const label = readableOn(color, theme.surface, 4.5) ?? theme.text;
  const shown = drawable(content.title);
  const title = shown.length > MAX_COVER_HEADLINE ? `${shown.slice(0, MAX_COVER_HEADLINE - 2).trimEnd()}…` : shown;
  const tag = content.tag && drawable(content.tag);
  // The portal's logo (or its name beside a square of its colour), as the link card has it.
  const brand = (
    <div style={{ display: "flex", alignItems: "center", height: 64 * SCALE, minWidth: 0 }}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- an image in the cover, not a page.
        <img src={logo.src} width={logo.width * SCALE} height={logo.height * SCALE} alt="" style={{ objectFit: "contain" }} />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 22, minWidth: 0 }}>
          <div style={{ flexShrink: 0, width: 68, height: 68, borderRadius: 18, background: color, display: "flex" }} />
          <div style={{ ...oneLine, fontSize: 44, fontWeight: 700 }}>{drawable(site.project.name)}</div>
        </div>
      )}
      {logo && site.brand.logoText && <div style={{ ...oneLine, fontSize: 44, fontWeight: 700, marginLeft: 22 }}>{drawable(site.brand.logoText)}</div>}
    </div>
  );
  // On the colour, the logo keeps the page it was made for: a chip of it, so a logo in the colour itself still shows.
  const chip = (
    <div style={{ display: "flex", alignSelf: "flex-start", maxWidth: "100%", background: theme.page, color: theme.text, borderRadius: 28, padding: "10px 28px", boxShadow: "0 10px 30px rgba(0,0,0,0.14)" }}>
      {brand}
    </div>
  );
  const heading = (sizes: [number, number, number], breaks: [number, number]) => (
    <div
      style={{
        fontFamily: "Bricolage Grotesque",
        fontSize: title.length > breaks[1] ? sizes[2] : title.length > breaks[0] ? sizes[1] : sizes[0],
        fontWeight: 700,
        lineHeight: 1.06,
        letterSpacing: -2,
        display: "block",
        lineClamp: 3,
      }}
    >
      {title}
    </div>
  );
  const pill = (background: string, text: string) =>
    tag && <div style={{ display: "flex", alignSelf: "flex-start", fontSize: 30, fontWeight: 700, color: text, background, borderRadius: 9999, padding: "8px 26px", marginBottom: 28 }}>{tag}</div>;

  switch (design) {
    case "title":
      return (
        <div style={{ ...root, backgroundColor: color, color: on }}>
          {/* Two soft discs off the corner, for depth. */}
          <div style={{ display: "flex", position: "absolute", right: -240, bottom: -360, width: 960, height: 960, borderRadius: 9999, background: `${ink}0.09)` }} />
          <div style={{ display: "flex", position: "absolute", right: -120, bottom: -460, width: 700, height: 700, borderRadius: 9999, background: `${ink}0.09)` }} />
          <div style={{ ...column, width: 1240 }}>
            {chip}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {pill(theme.page, theme.text)}
              {heading([124, 100, 78], [30, 60])}
            </div>
          </div>
        </div>
      );
    case "screenshot": {
      // A phone's screenshot stands upright in a narrow frame; anything else fills a wide one. Both run off the bottom edge.
      const upright = picture !== null && picture.height > picture.width * 1.2;
      const frame = upright ? { left: 1010, top: 96, width: 440, height: 900 } : { left: 800, top: 132, width: 980, height: 800 };
      return (
        <div style={{ ...root, backgroundColor: color, color: on }}>
          <div style={{ ...column, width: upright ? 820 : 640 }}>
            {chip}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {pill(theme.page, theme.text)}
              {heading([92, 76, 62], [26, 48])}
            </div>
          </div>
          {picture && (
            <div style={{ display: "flex", position: "absolute", ...frame, padding: 14, borderRadius: 30, background: theme.page, boxShadow: "0 40px 90px rgba(0,0,0,0.3)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- an image in the cover, not a page. */}
              <img src={picture.src} width={frame.width - 28} height={frame.height - 28} alt="" style={{ objectFit: "cover", objectPosition: "top left", borderRadius: 18 }} />
            </div>
          )}
        </div>
      );
    }
    case "sections": {
      const listed = content.headings.slice(0, 4);
      const more = content.headings.length - listed.length;
      return (
        <div style={{ ...root, backgroundColor: theme.page, color: theme.text }}>
          <div style={{ display: "flex", position: "absolute", left: 0, top: 0, bottom: 0, width: 18, background: color }} />
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 780, padding: "84px 48px 84px 110px" }}>
            {brand}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {pill(theme.chip, label)}
              {heading([88, 72, 58], [26, 48])}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 38, flexGrow: 1, minWidth: 0, margin: "84px 96px 84px 0", padding: "0 56px", background: theme.chip, border: `3px solid ${theme.chipEdge}`, borderRadius: 36 }}>
            {listed.map((text, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 24, minWidth: 0 }}>
                <div style={{ display: "flex", flexShrink: 0, width: 22, height: 22, borderRadius: 9999, background: accent }} />
                <div style={{ ...oneLine, fontSize: 40, fontWeight: 700 }}>{text}</div>
              </div>
            ))}
            {more > 0 && <div style={{ display: "flex", fontSize: 32, fontWeight: 500, color: theme.muted, marginLeft: 46 }}>{`and ${more} more`}</div>}
          </div>
        </div>
      );
    }
    case "pattern":
      return (
        <div style={{ ...root, backgroundColor: theme.page, color: theme.text }}>
          {/* Rings of the colour around the corner, fading as they widen. */}
          {[0, 1, 2, 3, 4].map((i) => {
            const size = 360 + i * 180;
            return <div key={i} style={{ display: "flex", position: "absolute", right: -size / 2, bottom: -size / 2, width: size, height: size, borderRadius: 9999, border: `46px solid ${accent}`, opacity: 0.9 - i * 0.18 }} />;
          })}
          {/* Clear of the widest ring, which reaches 1050 across at the title's height. */}
          <div style={{ ...column, width: 840 }}>
            {brand}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {pill(theme.chip, label)}
              {heading([112, 92, 72], [24, 50])}
            </div>
          </div>
        </div>
      );
    case "background":
      // The team's image filling the cover, darkened towards the foot so the white title reads on any of it.
      return (
        <div style={{ ...root, backgroundColor: "#1c1917", color: "#ffffff" }}>
          {picture && (
            // eslint-disable-next-line @next/next/no-img-element -- an image in the cover, not a page.
            <img src={picture.src} width={COVER_SIZE.width} height={COVER_SIZE.height} alt="" style={{ position: "absolute", left: 0, top: 0, objectFit: "cover" }} />
          )}
          <div style={{ display: "flex", position: "absolute", left: 0, right: 0, bottom: 0, height: 600, backgroundImage: "linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.78))" }} />
          {/* Placed too, so it's drawn over them (placed layers are drawn over the rest, as on a page). */}
          <div style={{ ...column, position: "relative", width: 1240 }}>
            {chip}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {pill(theme.page, theme.text)}
              {heading([112, 92, 72], [30, 60])}
            </div>
          </div>
        </div>
      );
  }
}
