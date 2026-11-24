import { renderToStaticMarkup } from "react-dom/server";
import satori from "satori";
import sharp from "sharp";
import { expect, test } from "vitest";

import type { Branding } from "@/server/operations/branding";

import { automaticDesign, COVER_DESIGNS, COVER_SIZE, type CoverContent, coverDesigns, coverElement, drawCover } from "./cover-card";
import { fonts } from "./share-card";

const site = (brand: Partial<Branding> = {}) => ({ project: { name: "Acme" }, brand: { color: "#6d4aff", colorScheme: "light", logo: null, logoDark: null, logoText: "", ...brand } as Branding });
const content = (more: Partial<CoverContent> = {}): CoverContent => ({ title: "Dark mode and faster search", tag: "New", headings: [], image: null, ...more });
const picture = async (width: number, height: number) => ({
  src: `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#dddddd" } }).png().toBuffer()).toString("base64")}`,
  width,
  height,
});
const shown = (...args: Parameters<typeof coverElement>) => renderToStaticMarkup(coverElement(...args));

test("an entry is offered the designs it has something to show in, and gets its image's by default", () => {
  expect(coverDesigns(content())).toEqual(["title", "pattern"]);
  expect(coverDesigns(content({ headings: ["Dark mode"] }))).toEqual(["title", "pattern"]);
  expect(coverDesigns(content({ headings: ["Dark mode", "Search"], image: { id: "m1", width: 1200, height: 800 } }))).toEqual([...COVER_DESIGNS]);
  expect(automaticDesign(content())).toBe("title");
  expect(automaticDesign(content({ image: { id: "m1", width: 1200, height: 800 } }))).toBe("screenshot");
});

test("every design says the title and the tag, with the portal's name where it has no logo, and nothing its fonts can't draw", () => {
  for (const design of COVER_DESIGNS) {
    const cover = shown(site(), content({ title: "Dark mode 🎉 is here", headings: ["Themes", "Search"] }), design, null, null);
    expect(cover).toContain("Dark mode is here");
    expect(cover).toContain(">New<");
    expect(cover).toContain(">Acme<");
  }
  // Untagged: no empty pill. A very long title is cut short.
  expect(shown(site(), content({ tag: null }), "title", null, null)).not.toContain("border-radius:9999px;padding:8px 26px");
  expect(shown(site(), content({ title: "x".repeat(200) }), "pattern", null, null)).toContain(`${"x".repeat(88)}…`);
});

test("on the portal's colour the text is white where that reads, near-black on a pale colour; the logo sits on a chip of the page", () => {
  const cover = (color: string | null, colorScheme = "light") => shown(site({ color, colorScheme } as Partial<Branding>), content(), "title", null, null);
  expect(cover("#6d4aff")).toContain("background-color:#6d4aff;color:#ffffff");
  expect(cover("#f5d90a")).toContain("background-color:#f5d90a;color:#1c1917");
  // No colour of its own: the brand green.
  expect(cover(null)).toContain("background-color:#12804a;color:#ffffff");
  // The chip is the portal's page, light or dark.
  expect(cover("#6d4aff")).toContain("background:#faf8f4;color:#1c1917");
  expect(cover("#6d4aff", "dark")).toContain("background:#0f0e0d;color:#fafaf9");
});

test("Sections lists the entry's first four headings and counts the rest; Pattern and Sections are on the portal's page, dark if it is", () => {
  const cover = shown(site({ colorScheme: "dark" } as Partial<Branding>), content({ headings: ["One", "Two", "Three", "Four", "Five", "Six"] }), "sections", null, null);
  for (const heading of ["One", "Two", "Three", "Four"]) {
    expect(cover).toContain(`>${heading}<`);
  }
  expect(cover).not.toContain(">Five<");
  expect(cover).toContain("and 2 more");
  expect(cover).toContain("background-color:#0f0e0d");
  expect(shown(site(), content(), "pattern", null, null)).toContain("background-color:#faf8f4");
});

test("Screenshot frames the entry's image: wide for a screen's, upright for a phone's", async () => {
  const wide = shown(site(), content(), "screenshot", null, await picture(1200, 800));
  expect(wide).toContain('src="data:image/png;base64,');
  expect(wide).toContain("width:980px");
  expect(shown(site(), content(), "screenshot", null, await picture(600, 1300))).toContain("width:440px");
});

test("each design draws, at the cover's size or a preview's", async () => {
  const full = content({ headings: ["Themes", "Search", "Привет", "Sharing", "More"] });
  for (const design of COVER_DESIGNS) {
    // The renderer refuses styles it can't lay out: each design as it is, with an image where it takes one.
    await satori(coverElement(site(), full, design, null, await picture(1200, 800)), { ...COVER_SIZE, fonts: await fonts });
  }
  // Without uploads there's no image to read: Screenshot falls back to the title's design rather than an empty frame.
  for (const design of ["title", "screenshot"] as const) {
    const { width, height, format } = await sharp(await drawCover(site(), full, design)).metadata();
    expect({ width, height, format }).toEqual({ ...COVER_SIZE, format: "png" });
  }
  const preview = await sharp(await drawCover(site({ colorScheme: "dark" } as Partial<Branding>), full, "sections", 800)).metadata();
  expect([preview.width, preview.height]).toEqual([800, 420]);
});
