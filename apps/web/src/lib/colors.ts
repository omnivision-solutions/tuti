/** Colour maths shared by the server and the app's previews (no server imports here). */
import { luminance, textColorOn } from "@tuti/shared/colors";

/** A colour typed as hex (`#rrggbb`, or `#rgb` expanded; the `#` optional) as `#rrggbb` in lower case; null if it isn't one. */
export function parseHex(typed: string): string | null {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typed.trim())?.[1]?.toLowerCase();
  return hex ? `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}` : null;
}

export { luminance, textColorOn } from "@tuti/shared/colors";

/**
 * Relative luminance of the surfaces the accent is hardest to read on (globals.css): the
 * page background in light mode, cards in dark mode.
 */
const SURFACES = { light: 0.9823, dark: 0.0106 };
/** WCAG's minimum for buttons, focus rings and large text. */
const MIN_CONTRAST = 3;

/** WCAG's minimum for text at body size: a shade made for a too-faint accent is also its links' colour. */
const TEXT_CONTRAST = 4.5;

const readsOn = (color: string, surface: number, min = MIN_CONTRAST) => {
  const l = luminance(color);
  return (Math.max(l, surface) + 0.05) / (Math.min(l, surface) + 0.05) >= min;
};

/** Whether `color` stands out from the page in light mode and in dark (a button on any site: the widget's launcher). */
export const readsEverywhere = (color: string) => readsOn(color, SURFACES.light) && readsOn(color, SURFACES.dark);

/**
 * The quiet tint of `color` and the text on it (`--soft`, `--soft-foreground`: a voted idea, the open board, the team's
 * replies), at the lightness of Tuti's own green tints in each mode (globals.css), so they read the same whatever the hue.
 */
const softCss = (color: string, dark: boolean) =>
  dark
    ? `--soft:oklch(from ${color} 0.3 min(c, 0.05) h);--soft-foreground:oklch(from ${color} 0.86 min(c, 0.11) h)`
    : `--soft:oklch(from ${color} 0.955 min(c, 0.035) h);--soft-foreground:oklch(from ${color} 0.43 min(c, 0.13) h)`;

/**
 * `color`, or where it's too faint on `surface` the nearest shade of it that reads: mixed toward black on the light page,
 * toward white on the dark one (the same hue), by as little as reads as text at body size (its links). Null for a grey that doesn't read
 * (white on the light page, or a pale tint whose shade is near grey): a mid grey would look disabled, so the text colour is the accent there.
 */
const toHex = (channels: number[]) => `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

const readableOn = (color: string, surface: number): string | null => {
  if (readsOn(color, surface)) {
    return color;
  }
  const target = surface > 0.5 ? 0 : 255;
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mix = (t: number) => channels.map((c) => Math.round(c + (target - c) * t));
  let [low, high] = [0, 1];
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    [low, high] = readsOn(toHex(mix(middle)), surface, TEXT_CONTRAST) ? [low, middle] : [middle, high];
  }
  const shade = mix(high);
  // Judged on the shade: a pale tint (beige) keeps too little colour once it's dark enough to read.
  return Math.max(...shade) - Math.min(...shade) < 24 ? null : toHex(shade);
};

/**
 * CSS that makes `color` the accent (`--primary`, with black or white text on it, and the
 * focus ring) and its tint (`--soft`). In a mode where it would be too faint against the page (a pale yellow in light
 * mode, a navy in dark mode), the accent there is the nearest shade of it that reads (readableOn): a grey's, the text colour. Null without a colour.
 */
export function brandCss(color: string | null): string | null {
  if (!color) {
    return null;
  }
  const accent = (surface: number) => {
    const shade = readableOn(color, surface);
    return shade
      ? `--primary:${shade};--primary-foreground:${textColorOn(shade)};--ring:${shade}`
      : "--primary:var(--foreground);--primary-foreground:var(--background);--ring:var(--foreground)";
  };
  // html:not(.dark) and html.dark outrank globals.css's :root and .dark wherever this lands.
  // The tints need relative colours with maths on a channel (Safari 16.4–17 has relative colours without it): a browser
  // without them keeps the default tint rather than none.
  return `html:not(.dark){${accent(SURFACES.light)}}html.dark{${accent(SURFACES.dark)}}@supports (color:oklch(from red 0.5 min(c, 0.1) h)){html:not(.dark){${softCss(color, false)}}html.dark{${softCss(color, true)}}}`;
}

/**
 * The widget panel's header: the team's colour (`#rrggbb`; null for the brand green, with its
 * foreground) as a gradient, with black or white text on it. The colour picked even where the page's
 * accent falls back to the text colour (brandCss: too little contrast with the page doesn't matter on a
 * band with its own text). The gradient only shades away from the text colour, so the text reads at
 * least as well everywhere as on the colour itself.
 */
export function widgetHeaderStyle(color: string | null): { backgroundColor: string; backgroundImage: string; color: string } {
  const base = color ?? "var(--primary)";
  const text = color ? textColorOn(color) : "var(--primary-foreground)";
  // The text colour's opposite (for the brand green, worked out in CSS: its foreground differs by mode),
  // mixed in oklab: oklch would turn the hue toward the opposite's (red, for its hue 0) on the way.
  const away = color ? (text === "#ffffff" ? "#000000" : "#ffffff") : "oklch(from var(--primary-foreground) calc(1 - l) 0 0)";
  // The colour on its own too: a browser without color-mix or relative colours drops only the gradient.
  return { backgroundColor: base, backgroundImage: `linear-gradient(135deg, ${base}, color-mix(in oklab, ${base}, ${away} 22%))`, color: text };
}
