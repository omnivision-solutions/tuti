import { readFile } from "node:fs/promises";

import { imageKey, imageWidths } from "@tuti/content/media";
import { log } from "@tuti/shared";
import { readableOn, SURFACES } from "@tuti/shared/colors";
import { mediaStorage } from "@tuti/shared/storage";
import satori from "satori";
import sharp from "sharp";

import type { Branding } from "@/server/operations/branding";

/**
 * Static cuts of the brand fonts (packages/ui's) with every Latin script they have, and Noto Sans for Cyrillic and Greek
 * and Noto Sans Math's symbols (scripts/fetch-fonts.mjs makes them): the image renderer reads neither WOFF2 nor variable fonts.
 */
export const fonts = Promise.all(
  (
    [
      ["Bricolage Grotesque", "bricolage-grotesque-700.ttf", 700],
      ["Figtree", "figtree-500.ttf", 500],
      ["Figtree", "figtree-700.ttf", 700],
      // Cyrillic and Greek, which the brand fonts don't have.
      ["Noto Sans", "noto-sans-500.ttf", 500],
      ["Noto Sans", "noto-sans-700.ttf", 700],
      // Symbols none of them has (✓, →, ⋯), as the app's and portals' fallback (docs/design.md, Type).
      ["Noto Sans Math", "noto-sans-math.ttf", 400],
    ] as const
  ).map(async ([name, file, weight]) => ({ name, weight, style: "normal" as const, data: await readFile(new URL(`../fonts/og/${file}`, import.meta.url)) })),
);

/** The brand green (emails' too), for a portal without a colour of its own. */
const TUTI_GREEN = "#12804a";

const THEMES = {
  light: { page: "#ffffff", text: "#1c1917", muted: "#6b6560", chip: "#f3f0ea", surface: SURFACES.light },
  dark: { page: "#0f0e0d", text: "#fafaf9", muted: "#a8a29e", chip: "#262321", surface: SURFACES.dark },
};

export type ShareCard = {
  /** What it is, above the title: "Documentation · Billing", "Feature requests", "Changelog". */
  eyebrow: string;
  title: string;
  /** Short facts under it, as pills ("Planned", "42 votes", "3 November 2026"). */
  facts?: string[];
};

/**
 * A portal page's link card (1200×630 PNG): the portal's logo (or name) and colour, the page's title big and bold, what
 * it is above it and a few facts under it, and the portal's address. In the portal's look: dark if the team made it dark.
 */
export async function shareCard(site: { project: { name: string }; brand: Branding }, card: ShareCard, address: string, headers: Record<string, string>): Promise<Response> {
  const theme = THEMES[site.brand.colorScheme === "dark" ? "dark" : "light"];
  const color = site.brand.color ?? TUTI_GREEN;
  // The accent as text: the nearest shade of it that reads on the page (as the portal's own accent), else the text colour.
  const accent = readableOn(color, theme.surface, 4.5) ?? theme.text;
  const logo = await logoImage(site.brand.colorScheme === "dark" ? (site.brand.logoDark ?? site.brand.logo) : site.brand.logo);
  const shown = { title: drawable(card.title), eyebrow: drawable(card.eyebrow), facts: card.facts?.map(drawable) };
  const title = shown.title.length > 90 ? `${shown.title.slice(0, 88).trimEnd()}…` : shown.title;
  const host = address.replace(/^https?:\/\//, "");
  // Satori itself, not next/og: for a character its fonts don't have, next/og fetches a font from Google Fonts with the text
  // in the address (a private post's title too), which a server without the internet can't do either.
  const svg = await satori(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          // A wash of the portal's colour from the top right corner.
          backgroundColor: theme.page,
          backgroundImage: `radial-gradient(circle at 100% 0%, ${color}38 0%, ${color}12 35%, ${color}00 60%)`,
          color: theme.text,
          fontFamily: "Figtree",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, padding: "64px 80px 0" }}>
          <div style={{ display: "flex", alignItems: "center", height: 64 }}>
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- an image in the share card, not a page.
              <img src={logo.src} width={logo.width} height={logo.height} alt="" style={{ objectFit: "contain" }} />
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <div style={{ width: 56, height: 56, borderRadius: 14, background: color, display: "flex" }} />
                <div style={{ fontSize: 36, fontWeight: 700 }}>{site.project.name}</div>
              </div>
            )}
            {logo && site.brand.logoText && <div style={{ fontSize: 36, fontWeight: 700, marginLeft: 18 }}>{site.brand.logoText}</div>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", paddingBottom: 24 }}>
            {shown.eyebrow && <div style={{ fontSize: 30, fontWeight: 700, color: accent, marginBottom: 20, display: "flex" }}>{shown.eyebrow}</div>}
            <div
              style={{
                fontFamily: "Bricolage Grotesque",
                fontSize: title.length > 60 ? 62 : title.length > 28 ? 76 : 96,
                fontWeight: 700,
                lineHeight: 1.08,
                letterSpacing: -1.5,
                display: "block",
                lineClamp: 3,
                maxWidth: 1000,
              }}
            >
              {title}
            </div>
            {shown.facts && shown.facts.length > 0 && (
              <div style={{ display: "flex", gap: 14, marginTop: 34 }}>
                {shown.facts.map((fact) => (
                  <div key={fact} style={{ display: "flex", fontSize: 26, fontWeight: 500, color: theme.muted, background: theme.chip, borderRadius: 9999, padding: "8px 22px" }}>
                    {fact}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 80px 44px", fontSize: 26, fontWeight: 500, color: theme.muted }}>
          <div style={{ display: "flex" }}>{host}</div>
        </div>
        <div style={{ display: "flex", height: 14, background: color }} />
      </div>
    ),
    { width: 1200, height: 630, fonts: await fonts },
  );
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", ...headers } });
}

/**
 * Text as the card can draw it: without emoji and their parts (flags' letters, skin tones, joiners, keycaps; the fonts
 * have none, and a box would show in its place), but with © ® ™, which they
 * have (the renderer takes ↔ to ↪ for emoji, so those go).
 * ponytail: scripts the fonts lack (Chinese, Japanese, Arabic…) still show as boxes; bundle Noto subsets for them when portals need it.
 */
export const drawable = (text: string) =>
  text.replace(/(?![©®™])[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\u20E3\uFE0F]/gu, "").replace(/\s{2,}/g, " ").trim();

/**
 * The logo's size on the card (at most 64px tall and 520 wide), and the stored width to read: the smallest that's twice
 * that (the original's, at most), so it's never scaled up.
 */
export function logoSize(logo: { width: number; height: number }) {
  const scale = Math.min(64 / logo.height, 520 / logo.width);
  const [width, height] = [Math.round(logo.width * scale), Math.round(logo.height * scale)];
  const widths = imageWidths(logo.width);
  return { width, height, stored: widths.find((w) => w >= width * 2) ?? widths.at(-1)! };
}

/**
 * The logo as a PNG (the renderer can't read the stored WebP), at most 64px tall and 520 wide; null without one, or if
 * it can't be read (the card shows the portal's name instead).
 */
async function logoImage(logo: Branding["logo"]) {
  const storage = mediaStorage();
  if (!logo || !storage) {
    return null;
  }
  try {
    const { width, height, stored } = logoSize(logo);
    const webp = await storage.get(imageKey(logo.id, stored));
    // Twice the size it shows at, for sharp edges.
    const png = await sharp(webp).resize(width * 2, height * 2, { fit: "inside" }).png().toBuffer();
    return { src: `data:image/png;base64,${png.toString("base64")}`, width, height };
  } catch (error) {
    log.warn("Couldn't read the logo for a share card", { mediaId: logo.id, error });
    return null;
  }
}
