import { readFile } from "node:fs/promises";

import { imageKey, imageWidths } from "@tuti/content/media";
import { log } from "@tuti/shared";
import { luminance, readableOn, SURFACES } from "@tuti/shared/colors";
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
export const TUTI_GREEN = "#12804a";

export const THEMES = {
  light: { page: "#faf8f4", text: "#1c1917", muted: "#6b6560", chip: "#ffffff", chipEdge: "#e7e0d5", surface: SURFACES.light },
  dark: { page: "#0f0e0d", text: "#fafaf9", muted: "#a8a29e", chip: "#1c1a18", chipEdge: "#34302c", surface: SURFACES.dark },
};

/** The drawing on the card's colour panel: what kind of page it is, at a glance. */
export type Picture = "page" | "board" | "roadmap" | "changelog" | { votes: number };

export type ShareCard = {
  /** What it is, above the title: "Documentation · Billing", "Feature requests", "Changelog". */
  eyebrow: string;
  title: string;
  /** Short facts under it, as pills ("Planned", "42 votes", "3 November 2026"). */
  facts?: string[];
  picture: Picture;
};

type Site = { project: { name: string }; brand: Branding };
type Logo = { src: string; width: number; height: number } | null;

/**
 * A portal page's link card (1200×630 PNG): on the left the portal's logo (or name), what the page is, its title big and
 * bold, a few facts and the portal's address; on the right a panel in the portal's colour with a drawing of the page's
 * kind (an article, a post's votes, the roadmap's columns, the changelog's timeline), and "Powered by tuti" (its mark grey,
 * beside any colour) unless the team hides it on the portal. In the portal's look: dark if the team made it dark.
 */
export async function shareCard(site: Site, card: ShareCard, address: string, headers: Record<string, string>): Promise<Response> {
  const logo = await logoImage(site.brand.colorScheme === "dark" ? (site.brand.logoDark ?? site.brand.logo) : site.brand.logo);
  // Satori itself, not next/og: for a character its fonts don't have, next/og fetches a font from Google Fonts with the text
  // in the address (a private post's title too), which a server without the internet can't do either.
  const svg = await satori(cardElement(site, card, address, logo), { width: 1200, height: 630, fonts: await fonts });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", ...headers } });
}

/** A name or logo text on the logo's row: one line, cut short with an ellipsis rather than run under the panel. */
export const oneLine = { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 } as const;

export function cardElement(site: Site, card: ShareCard, address: string, logo: Logo) {
  const theme = THEMES[site.brand.colorScheme === "dark" ? "dark" : "light"];
  const color = site.brand.color ?? TUTI_GREEN;
  // The accent as text: the nearest shade of it that reads on the page (as the portal's own accent), else the text colour.
  const accent = readableOn(color, theme.surface, 4.5) ?? theme.text;
  const shown = { title: drawable(card.title), eyebrow: drawable(card.eyebrow), facts: card.facts?.map(drawable) };
  const title = shown.title.length > 90 ? `${shown.title.slice(0, 88).trimEnd()}…` : shown.title;
  const host = address.replace(/^https?:\/\//, "");
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", backgroundColor: theme.page, color: theme.text, fontFamily: "Figtree" }}>
      {/* Satori adds padding to a width: 652 + 80 + 40 is the text's side, the panel and its margin the rest. */}
      <div style={{ width: 652, flexShrink: 0, display: "flex", flexDirection: "column", padding: "64px 40px 56px 80px" }}>
        <div style={{ display: "flex", alignItems: "center", height: 64 }}>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- an image in the share card, not a page.
            <img src={logo.src} width={logo.width} height={logo.height} alt="" style={{ objectFit: "contain" }} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 18, minWidth: 0 }}>
              <div style={{ flexShrink: 0, width: 56, height: 56, borderRadius: 14, background: color, display: "flex" }} />
              <div style={{ ...oneLine, fontSize: 34, fontWeight: 700 }}>{drawable(site.project.name)}</div>
            </div>
          )}
          {logo && site.brand.logoText && <div style={{ ...oneLine, fontSize: 34, fontWeight: 700, marginLeft: 18 }}>{drawable(site.brand.logoText)}</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", paddingBottom: 16 }}>
          {shown.eyebrow && <div style={{ fontSize: 26, fontWeight: 700, color: accent, marginBottom: 16, display: "flex" }}>{shown.eyebrow}</div>}
          <div
            style={{
              fontFamily: "Bricolage Grotesque",
              fontSize: title.length > 48 ? 54 : title.length > 26 ? 64 : 76,
              fontWeight: 700,
              lineHeight: 1.06,
              letterSpacing: -1.5,
              display: "block",
              lineClamp: 3,
            }}
          >
            {title}
          </div>
          {shown.facts && shown.facts.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 28 }}>
              {shown.facts.map((fact) => (
                <div
                  key={fact}
                  style={{ display: "flex", fontSize: 22, fontWeight: 700, color: theme.muted, background: theme.chip, border: `2px solid ${theme.chipEdge}`, borderRadius: 9999, padding: "6px 18px" }}
                >
                  {fact}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", fontSize: 24, fontWeight: 500, color: theme.muted }}>{host}</div>
      </div>
      <Panel color={color} picture={card.picture} poweredBy={site.brand.poweredBy} />
    </div>
  );
}

/** The panel in the portal's colour: its drawing, and "Powered by tuti" under it, with room kept so they never meet. */
function Panel({ color, picture, poweredBy }: { color: string; picture: Picture; poweredBy: boolean }) {
  // On a pale colour (a yellow, a light grey) white shapes would vanish: the shapes are dark there.
  const pale = luminance(color) > 0.6;
  const ink = pale ? "rgba(28,25,23," : "rgba(255,255,255,";
  // The votes' number in the colour where it reads on white, else the text colour.
  const onWhite = readableOn(color, 1, 3) ?? "#1c1917";
  // White cards on a near-white colour (#ffffff, a light grey) get an edge, or they'd have none.
  const edge = pale ? "3px solid rgba(28,25,23,0.18)" : "3px solid transparent";
  return (
    <div
      style={{
        width: 400,
        flexShrink: 0,
        margin: "28px 28px 28px 0",
        borderRadius: 36,
        backgroundColor: color,
        // Two soft circles, as the background (shapes would be drawn over the drawing).
        backgroundImage: `radial-gradient(circle 150px at 340px 60px, ${ink}0.12) 99%, transparent 100%), radial-gradient(circle 140px at 60px 534px, rgba(0,0,0,0.12) 99%, transparent 100%)`,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        paddingBottom: poweredBy ? 76 : 0,
      }}
    >
      <Drawing picture={picture} ink={ink} solid={pale ? "#1c1917" : "#ffffff"} number={onWhite} edge={edge} />
      {poweredBy && (
        <div style={{ position: "absolute", bottom: 26, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "#ffffff",
              borderRadius: 9999,
              padding: "8px 20px",
              boxShadow: "0 6px 18px rgba(0,0,0,0.15)",
              fontSize: 22,
              fontWeight: 500,
              color: "#57534e",
            }}
          >
            Powered by
            <MonoMark />
            <div style={{ display: "flex", fontFamily: "Bricolage Grotesque", fontWeight: 700, fontSize: 24, color: "#1c1917" }}>tuti</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tuti's parrot in grey (TutiMark's `mono`): beside a team's colour, Tuti's green and orange would clash. */
function MonoMark() {
  return (
    <svg width={26} height={26} viewBox="0 0 32 32">
      <path d="M16 3C9 3 4 8.5 4 15.5S9 29 15 29c1.5 0 2-1 2-2v-6c4 0 9-2.5 9-9C26 7 21.5 3 16 3Z" fill="#57534e" />
      <path d="M24 10.5c3 .5 5 2.5 5 5.5-2.2-1.2-3.8-1.4-5.6-1.1Z" fill="#57534e" fillOpacity={0.55} />
      <circle cx="18.5" cy="10.5" r="2.2" fill="#ffffff" />
      <circle cx="19" cy="10.5" r="1.1" fill="#1c1917" />
    </svg>
  );
}

const box = (style: Record<string, unknown>, key?: number) => <div key={key} style={{ display: "flex", ...style }} />;

function Drawing({ picture, ink, solid, number, edge }: { picture: Picture; ink: string; solid: string; number: string; edge: string }) {
  if (typeof picture === "object") {
    const votes = picture.votes.toLocaleString("en");
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: 220, height: 240, borderRadius: 36, background: "#ffffff", border: edge, color: number, gap: 4 }}>
        <svg width={52} height={44} viewBox="0 0 26 22">
          <path d="M13 0 26 22H0Z" fill={number} />
        </svg>
        <div style={{ display: "flex", fontFamily: "Bricolage Grotesque", fontWeight: 700, fontSize: votes.length > 4 ? 60 : votes.length > 2 ? 76 : 96 }}>{votes}</div>
      </div>
    );
  }
  switch (picture) {
    case "roadmap":
      // Planned, in progress and done: cards in columns, the done ones faded.
      return (
        <div style={{ display: "flex", gap: 18 }}>
          {[3, 2, 4].map((n, column) => (
            <div key={column} style={{ display: "flex", flexDirection: "column", gap: 12, width: 96 }}>
              {box({ height: 12, width: 56, borderRadius: 6, background: `${ink}0.6)`, marginBottom: 6 })}
              {Array.from({ length: n }, (_, i) => (
                <div key={i} style={{ display: "flex", height: 52, borderRadius: 12, background: column === 2 ? `${ink}0.35)` : solid }} />
              ))}
            </div>
          ))}
        </div>
      );
    case "changelog":
      // A timeline: the newest entry bright, older ones fading.
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          {[1, 0.55, 0.35].map((o, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 18 }}>
              {box({ width: 26, height: 26, borderRadius: 9999, background: `${ink}${o})` })}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {box({ width: i ? 180 : 230, height: 18, borderRadius: 9, background: `${ink}${o})` })}
                {box({ width: i ? 120 : 160, height: 18, borderRadius: 9, background: `${ink}${o * 0.6})` })}
              </div>
            </div>
          ))}
        </div>
      );
    case "board":
      // Ideas with their vote boxes.
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[1, 0.75, 0.5].map((o, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, width: 290, height: 72, borderRadius: 16, background: "#ffffff", border: edge, opacity: o, padding: "0 16px" }}>
              {box({ width: 40, height: 46, borderRadius: 10, border: `3px solid ${number}` })}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {box({ width: [170, 140, 150][i], height: 12, borderRadius: 6, background: "#44403c" })}
                {box({ width: [110, 90, 120][i], height: 10, borderRadius: 5, background: "#d6d3d1" })}
              </div>
            </div>
          ))}
        </div>
      );
    default:
      // An article: a page, another behind it.
      return (
        <div style={{ display: "flex", position: "relative", width: 250, height: 290 }}>
          {box({ position: "absolute", left: 30, top: 0, width: 220, height: 270, borderRadius: 22, background: `${ink}0.35)` })}
          <div style={{ position: "absolute", left: 0, top: 20, width: 220, height: 270, borderRadius: 22, background: "#ffffff", border: edge, display: "flex", flexDirection: "column", padding: 28, gap: 14 }}>
            {box({ width: 150, height: 20, borderRadius: 6, background: number })}
            {[120, 160, 100, 140, 120].map((w, i) => box({ width: w, height: 12, borderRadius: 6, background: "#e7e5e4" }, i))}
          </div>
        </div>
      );
  }
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
 * The logo's size on the card (at most 64px tall and 360 wide: the text's side is 652), and the stored width to read: the smallest that's twice
 * that (the original's, at most), so it's never scaled up.
 */
export function logoSize(logo: { width: number; height: number }) {
  const scale = Math.min(64 / logo.height, 360 / logo.width);
  const [width, height] = [Math.round(logo.width * scale), Math.round(logo.height * scale)];
  const widths = imageWidths(logo.width);
  return { width, height, stored: widths.find((w) => w >= width * 2) ?? widths.at(-1)! };
}

/**
 * The logo as a PNG (the renderer can't read the stored WebP), at most 64px tall and 360 wide; null without one, or if
 * it can't be read (the card shows the portal's name instead).
 */
export async function logoImage(logo: Branding["logo"]) {
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
