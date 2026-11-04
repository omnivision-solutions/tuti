import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const src = fileURLToPath(new URL("..", import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

test("fonts come from files in src/fonts, so a build never downloads them (one failed download failed it)", () => {
  const files = sources(src);
  expect(files.filter((file) => readFileSync(file, "utf8").includes('"next/font/google"'))).toEqual([]);
  // Every file a font names is there (next/font/local paths are relative to the file naming them).
  const named = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/"(\.\.\/fonts\/[^"]+\.woff2)"/g)].map(([, path]) => join(file, "..", path!)),
  );
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((path) => !existsSync(path))).toEqual([]);
});

test("a symbol none of the fonts has (an AI-written \"⋯\") falls back to the bundled symbols font after each of them, never an empty box", () => {
  const layout = readFileSync(join(src, "app/layout.tsx"), "utf8");
  const loader = layout.match(/localFont\({\s*src: "\.\.\/fonts\/noto-sans-math\.woff2",[^]*?}\);/)![0];
  expect(loader).toContain('variable: "--font-symbols"');
  // Its ranges: the ones the file was cut to (scripts/fetch-fonts.mjs), with "⋯" (U+22EF) in them.
  const range = loader.match(/prop: "unicode-range", value: "([^"]+)"/)![1]!;
  const script = readFileSync(join(src, "../../../scripts/fetch-fonts.mjs"), "utf8");
  expect(range.replaceAll(" ", "")).toBe(script.match(/const SYMBOLS = "([^"]+)"/)![1]);
  const ranges = range.split(",").map((part) => part.trim().slice(2).split("-").map((hex) => parseInt(hex, 16)));
  expect(ranges.some(([from, to = from]) => from! <= 0x22ef && 0x22ef <= to!)).toBe(true);
  // Not ▶ (U+25B6), which phones draw as colour emoji with an emoji selector (▶️).
  expect(ranges.some(([from, to = from]) => from! <= 0x25b6 && 0x25b6 <= to!)).toBe(false);
  expect(layout).toContain("${symbols.variable}");
  const css = readFileSync(join(src, "app/globals.css"), "utf8");
  for (const font of ["sans", "mono", "heading"]) {
    expect(css).toMatch(new RegExp(`--font-${font}: var\\([^)]+\\), var\\(--font-symbols\\);`));
  }
  // The portals' own fonts (Customize → Branding) too.
  expect(readFileSync(join(src, "components/portal-look.tsx"), "utf8")).toContain("fontFamily: `var(${fontVariable(body)}), var(--font-symbols)`");
});
