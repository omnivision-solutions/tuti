import { readFileSync } from "node:fs";

import type { ChangelogTag, PostStatus } from "@tuti/db";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

import { badgeVariants } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

import { PICKED_CHIP, TAG_LABELS, TAG_VARIANTS, TagBadge } from "./changelog-tag";
import { STATUS_STYLES } from "./post-status-badge";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const themes = [":root", ".dark"] as const;
const statuses = Object.keys(STATUS_STYLES) as PostStatus[];

type Oklch = [number, number, number];

/** A token's colour in a theme, as oklch [lightness, chroma, hue], read from the theme's block in globals.css. */
function token(theme: (typeof themes)[number], name: string): Oklch {
  const start = css.indexOf(`\n${theme}`);
  const match = css.slice(start, css.indexOf("}", start)).match(new RegExp(`--${name}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`));
  expect(match, `--${name} in ${theme}`).not.toBeNull();
  return match!.slice(1).map(Number) as Oklch;
}

/** oklch to gamma-encoded sRGB, 0–1 (Björn Ottosson's matrices), clipped to the gamut. */
function srgb([l, c, h]: Oklch) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ].map((v) => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
}

/** WCAG contrast between two gamma-encoded sRGB colours. */
function contrast(x: number[], y: number[]) {
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}

test.each(themes)("every status's dot has a colour of its own (%s): a hue apart, or for the greys a shade apart", (theme) => {
  const byStatus = Object.fromEntries(statuses.map((status) => [status, token(theme, STATUS_STYLES[status].dot.replace("bg-", ""))]));
  for (const [i, a] of statuses.entries()) {
    for (const b of statuses.slice(i + 1)) {
      const [la, ca, ha] = byStatus[a]!;
      const [lb, cb, hb] = byStatus[b]!;
      const grey = ca < 0.05 || cb < 0.05;
      const apart = grey ? Math.abs(la - lb) >= 0.1 || Math.abs(ca - cb) >= 0.05 : Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb)) >= 25;
      expect(apart, `${a} and ${b} in ${theme}`).toBe(true);
    }
  }
});

test("only Completed's badge is green: the statuses before it are quiet", () => {
  expect(statuses.filter((status) => STATUS_STYLES[status].badge === "default" || STATUS_STYLES[status].badge === "soft")).toEqual(["COMPLETED"]);
});

test("Breaking is the destructive colour, the other tags neutral", () => {
  expect(TAG_VARIANTS).toEqual({ NEW: "secondary", IMPROVED: "secondary", FIXED: "secondary", BREAKING: "destructive" });
  expect(renderToString(createElement(TagBadge, { tag: "BREAKING" }))).toContain("bg-destructive/10");
});

test("a tag picked in the editor has the colours of its badge on the portal", () => {
  for (const tag of Object.keys(TAG_LABELS) as ChangelogTag[]) {
    const badge = badgeVariants({ variant: TAG_VARIANTS[tag] }).split(" ");
    const picked = PICKED_CHIP[TAG_VARIANTS[tag]]
      .split(" ")
      .map((name) => name.replace("has-checked:", ""))
      .filter((name) => name !== "border-transparent");
    expect(badge, tag).toEqual(expect.arrayContaining(picked));
  }
});

test.each(themes)("a tag's text reads at its small size (%s): 4.5:1 on its fill, on the page and on a card", (theme) => {
  for (const variant of new Set(Object.values(TAG_VARIANTS))) {
    const classes = badgeVariants({ variant }).split(" ");
    // The colour class with that prefix (not text-xs): a token, or a share of one (bg-destructive/10).
    const tokenOf = (prefix: string) =>
      classes.map((name) => name.slice(prefix.length)).find((rest, i) => classes[i]!.startsWith(prefix) && css.includes(`--${rest.split("/")[0]}:`))!;
    // In dark mode, its own fill when it has one (dark:bg-destructive/20).
    const fill = (theme === ".dark" && tokenOf("dark:bg-")) || tokenOf("bg-");
    const [fillToken, percent = "100"] = fill.split("/");
    const text = srgb(token(theme, tokenOf("text-")));
    for (const page of ["background", "card"]) {
      const under = srgb(token(theme, page));
      const share = Number(percent) / 100;
      const over = srgb(token(theme, fillToken!)).map((v, i) => share * v + (1 - share) * under[i]!);
      expect(contrast(text, over), `${variant} on ${page} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test.each(themes)("a destructive button's text reads (%s): 4.5:1 on its fill and its hover's, on the page, a card and a dialog's footer", (theme) => {
  const classes = buttonVariants({ variant: "destructive" }).split(" ");
  const text = srgb(token(theme, classes.find((name) => name.startsWith("text-") && css.includes(`--${name.slice(5)}:`))!.slice(5)));
  // Its tints of a token (bg-destructive/10, hover:bg-destructive/20): in dark mode, its own (dark:…) where it sets them.
  const tints = classes.flatMap((name) => {
    const [, dark, hover, fill, percent] = name.match(/^(dark:)?(hover:)?bg-([\w-]+)\/(\d+)$/) ?? [];
    return fill ? [{ dark: !!dark, hover: !!hover, fill, share: Number(percent) / 100 }] : [];
  });
  for (const hover of [false, true]) {
    const options = tints.filter((tint) => tint.hover === hover);
    const tint = (theme === ".dark" && options.find((option) => option.dark)) || options.find((option) => !option.dark)!;
    const popover = srgb(token(theme, "popover"));
    // A dialog's footer (where its Delete is): bg-muted/50 over the dialog.
    const surfaces = { background: srgb(token(theme, "background")), card: srgb(token(theme, "card")), "a dialog's footer": srgb(token(theme, "muted")).map((v, i) => 0.5 * v + 0.5 * popover[i]!) };
    for (const [page, under] of Object.entries(surfaces)) {
      const over = srgb(token(theme, tint.fill)).map((v, i) => tint.share * v + (1 - tint.share) * under[i]!);
      expect(contrast(text, over), `${hover ? "hovered " : ""}on ${page} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
