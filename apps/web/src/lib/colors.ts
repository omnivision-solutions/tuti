/** Colour maths shared by the server and the app's previews (no server imports here). */

/** A `#rrggbb` colour's WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Black or white, whichever reads better on a `#rrggbb` background. */
export function textColorOn(hex: string): string {
  // Contrast with white is 1.05 / (L + 0.05), with black (L + 0.05) / 0.05; they're equal at L ≈ 0.179.
  return luminance(hex) > 0.179 ? "#000000" : "#ffffff";
}

/**
 * Relative luminance of the surfaces the accent is hardest to read on (globals.css): the
 * page background in light mode, cards in dark mode.
 */
const SURFACES = { light: 0.9823, dark: 0.0106 };
/** WCAG's minimum for buttons, focus rings and large text. */
const MIN_CONTRAST = 3;

/**
 * CSS that makes `color` the accent (`--primary`, with black or white text on it, and the
 * focus ring). In a mode where it would be too faint against the page (a pale yellow in light
 * mode, a navy in dark mode), the accent there is the text colour instead. Null without a colour.
 */
export function brandCss(color: string | null): string | null {
  if (!color) {
    return null;
  }
  const l = luminance(color);
  const accent = (surface: number) =>
    (Math.max(l, surface) + 0.05) / (Math.min(l, surface) + 0.05) >= MIN_CONTRAST
      ? `--primary:${color};--primary-foreground:${textColorOn(color)};--ring:${color}`
      : "--primary:var(--foreground);--primary-foreground:var(--background);--ring:var(--foreground)";
  // html:not(.dark) and html.dark outrank globals.css's :root and .dark wherever this lands.
  return `html:not(.dark){${accent(SURFACES.light)}}html.dark{${accent(SURFACES.dark)}}`;
}
