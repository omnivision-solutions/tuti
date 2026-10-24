/**
 * next/font/local under Vitest (vitest.config.mts aliases it here): Next.js compiles its loader when
 * the app is built, so tests get what the app reads from a font instead, a class and its variable.
 */
export default function localFont(options: { variable?: string } = {}) {
  return { className: "font", variable: options.variable ?? "", style: { fontFamily: "font" } };
}
