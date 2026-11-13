/** Colour maths shared by the app (lib/colors.ts) and emails; no server imports here. */

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

/** WCAG's minimum for text at body size: a shade made for a too-faint accent is also its links' colour. */
const TEXT_CONTRAST = 4.5;

/** Whether `color` (`#rrggbb`) has at least `min` contrast with a surface of relative luminance `surface` (3:1: WCAG's for buttons and large text). */
export function readsOn(color: string, surface: number, min = 3): boolean {
  const l = luminance(color);
  return (Math.max(l, surface) + 0.05) / (Math.min(l, surface) + 0.05) >= min;
}

const toHex = (channels: number[]) => `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/**
 * `color` (`#rrggbb`), or where it has under `min` contrast with `surface` (a relative luminance) the nearest shade of it
 * that reads: mixed toward black on a light surface, toward white on a dark one (the same hue), by as little as reads as
 * text at body size (4.5:1, its links). Null for a grey that doesn't read (white on a light surface, or a pale tint whose
 * shade is near grey): a mid grey would look disabled, so the text colour is the accent there. The portal's accent
 * (brandCss) and the emails' (accentColors) both take it.
 */
export function readableOn(color: string, surface: number, min = 3): string | null {
  if (readsOn(color, surface, min)) {
    return color;
  }
  const target = surface > 0.5 ? 0 : 255;
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mix = (t: number) => channels.map((c) => Math.round(c + (target - c) * t));
  let [low, high] = [0, 1];
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    [low, high] = readsOn(toHex(mix(middle)), surface, Math.max(min, TEXT_CONTRAST)) ? [low, middle] : [middle, high];
  }
  const shade = mix(high);
  // Judged on the shade: a pale tint (beige) keeps too little colour once it's dark enough to read.
  return Math.max(...shade) - Math.min(...shade) < 24 ? null : toHex(shade);
}
