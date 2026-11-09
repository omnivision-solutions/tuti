import { readFileSync } from "node:fs";

import type { ChangelogTag, PostStatus } from "@tuti/db";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { badgeVariants } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";

import { PICKED_CHIP, TAG_LABELS, TAG_VARIANTS, TagBadge } from "./changelog-tag";
import { STATUS_STYLES } from "./post-status-badge";
import { TargetBadge } from "./target-badge";

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

test.each(themes)("a status's pill reads at 4.5:1 (%s): the text on its tint, on the page and on a card", (theme) => {
  for (const status of statuses) {
    const [, fill, percent] = STATUS_STYLES[status].badge.match(/^bg-([\w-]+)\/(\d+)$/)!;
    for (const page of ["background", "card"]) {
      const tint = blend(srgb(token(theme, fill!)), srgb(token(theme, page)), Number(percent) / 100);
      expect(contrast(srgb(token(theme, "foreground")), tint), `${status} on ${page}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test.each(themes)("secondary text reads at 4.5:1 (%s): muted-foreground on the page, a card, the sidebar and a muted fill", (theme) => {
  for (const under of ["background", "card", "sidebar", "muted", "sidebar-accent"]) {
    expect(contrast(srgb(token(theme, "muted-foreground")), srgb(token(theme, under))), under).toBeGreaterThanOrEqual(4.5);
  }
});

test.each(themes)("a card and an input's edge show on the page (%s): the border at 1.25:1, the input's at 1.5:1", (theme) => {
  expect(contrast(srgb(token(theme, "border")), srgb(token(theme, "background")))).toBeGreaterThanOrEqual(1.25);
  expect(contrast(srgb(token(theme, "input")), srgb(token(theme, "background")))).toBeGreaterThanOrEqual(1.5);
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

/** The fill an avatar's initials get, by its classes. */
const avatarFill = (initials: string) =>
  renderToString(createElement(Avatar, null, createElement(AvatarFallback, null, initials))).match(/bg-(avatar-\d)/)?.[1];

test("initials are coloured, the same for a person's one and two letters, and neighbouring letters apart", () => {
  const fills = [..."ABCDEFGHIJKL"].map(avatarFill);
  expect(fills.every(Boolean)).toBe(true);
  for (const [i, fill] of fills.entries()) {
    expect(fill).not.toBe(fills[i + 1]);
  }
  expect(avatarFill("DR")).toBe(avatarFill("D"));
  // However a place makes the initials: lowercase, a leading space, composed or not, an emoji whole or cut in half.
  expect(avatarFill("d")).toBe(avatarFill("D"));
  expect(avatarFill(" D")).toBe(avatarFill("D"));
  expect(avatarFill("e\u0301")).toBe(avatarFill("\u00c9"));
  // A name stored decomposed, cut to its first unit, and one composed: "Ölaf" both ways.
  expect(avatarFill("O\u0308laf".slice(0, 1))).toBe(avatarFill("\u00d6"));
  expect(avatarFill("😀 Sam".slice(0, 1))).toBe(avatarFill("😀"));
});

test("initials read on every avatar colour (the same in both modes): 4.5:1", () => {
  const text = srgb(token(":root", "avatar-foreground"));
  for (const n of [1, 2, 3, 4, 5, 6]) {
    expect(contrast(text, srgb(token(":root", `avatar-${n}`))), `avatar-${n}`).toBeGreaterThanOrEqual(4.5);
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

/** Each element's classes in rendered HTML, in order. */
const classesIn = (html: string) => [...html.matchAll(/class="([^"]+)"/g)].map(([, names]) => names!.split(" "));
/** The token the class with that prefix names (`bg-muted-foreground`: muted-foreground), skipping ones that aren't a token (`ring-1`). */
const tokenIn = (classes: string[], prefix: string) =>
  classes.map((name) => name.slice(prefix.length).split("/")[0]!).find((rest, i) => classes[i]!.startsWith(prefix) && css.includes(`--${rest}:`))!;
/** `over` at `share` (0–1) on `under`, as the browser blends them. */
const blend = (over: number[], under: number[], share: number) => over.map((v, i) => share * v + (1 - share) * under[i]!);

test.each(themes)("a switch's parts read at 3:1 (%s): off, its track's edge on a card and its thumb on the track; on, the green on a card and its thumb on it; and off apart from on", (theme) => {
  const [classes] = classesIn(renderToString(createElement(Switch)));
  const of = (prefix: string) => srgb(token(theme, tokenIn(classes!, prefix)));
  const card = srgb(token(theme, "card"));
  expect(contrast(of("inset-ring-"), card), "off: its edge on a card").toBeGreaterThanOrEqual(3);
  expect(contrast(of("before:bg-"), of("bg-")), "off: its thumb on its track").toBeGreaterThanOrEqual(3);
  expect(contrast(of("checked:bg-"), card), "on: its track on a card").toBeGreaterThanOrEqual(3);
  expect(contrast(of("checked:before:bg-"), of("checked:bg-")), "on: its thumb on its track").toBeGreaterThanOrEqual(3);
  // Not only by hue (red-green colour blindness, a washed-out screen): a switch alone in a row has nothing to compare with.
  expect(contrast(of("bg-"), of("checked:bg-")), "off's track and on's").toBeGreaterThanOrEqual(3);
});

test.each(themes)("a progress bar's empty track is outlined at 3:1 on a dialog, and its fill reads on the track (%s)", (theme) => {
  const [track, fill] = classesIn(renderToString(createElement(Progress, { value: 0, max: 10 })));
  expect(contrast(srgb(token(theme, tokenIn(track!, "ring-"))), srgb(token(theme, "popover")))).toBeGreaterThanOrEqual(3);
  expect(contrast(srgb(token(theme, tokenIn(fill!, "bg-"))), srgb(token(theme, tokenIn(track!, "bg-"))))).toBeGreaterThanOrEqual(3);
});

test("in dark mode a popover stands out from the card it opens over by its edge, and the hovers inside it still show", () => {
  const source = readFileSync(new URL("./ui/popover.tsx", import.meta.url), "utf8");
  const surface = source.match(/dark:bg-([a-z-]+)/)?.[1] ?? "popover";
  const [, edge, percent] = source.match(/dark:ring-([a-z-]+)\/(\d+)/)!;
  const ring = blend(srgb(token(".dark", edge!)), srgb(token(".dark", surface)), Number(percent) / 100);
  expect(contrast(ring, srgb(token(".dark", "card")))).toBeGreaterThanOrEqual(2);
  // A row's hover in a popover (GitHub's repository picker: hover:bg-muted; the icon picker: hover:bg-accent).
  for (const hover of ["muted", "accent"]) {
    expect(token(".dark", hover)[0], hover).toBeGreaterThanOrEqual(token(".dark", surface)[0] + 0.03);
  }
});

test.each(themes)("Autopilot's badges read at 4.5:1 (%s): on their tint, on the page, a card and the row open beside the list", (theme) => {
  for (const badge of ["completing", "in_progress", "updated", "new"]) {
    const [classes] = classesIn(renderToString(createElement(TargetBadge, { badge })));
    const fill = classes!.find((name) => /^bg-[\w-]+\/\d+$/.test(name))!;
    const [fillToken, percent] = fill.slice(3).split("/");
    for (const under of ["background", "card", "muted"]) {
      const tint = blend(srgb(token(theme, fillToken!)), srgb(token(theme, under)), Number(percent) / 100);
      expect(contrast(srgb(token(theme, tokenIn(classes!, "text-"))), tint), `${badge} on ${under}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
