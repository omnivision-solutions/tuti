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
  const css = readFileSync(join(src, "app/globals.css"), "utf8");
  const face = css.match(/@font-face\s*{[^}]*font-family: "Tuti Symbols";[^}]*}/)![0];
  expect(existsSync(join(src, "app", face.match(/url\("([^"]+)"\)/)![1]!))).toBe(true);
  const ranges = face
    .match(/unicode-range: ([^;]+);/)![1]!
    .split(",")
    .map((range) => range.trim().slice(2).split("-").map((hex) => parseInt(hex, 16)));
  expect(ranges.some(([from, to = from]) => from! <= 0x22ef && 0x22ef <= to!)).toBe(true);
  for (const font of ["sans", "mono", "heading"]) {
    expect(css).toMatch(new RegExp(`--font-${font}: var\\([^)]+\\), "Tuti Symbols";`));
  }
  // The portals' own fonts (Customize → Branding) too.
  expect(readFileSync(join(src, "components/portal-look.tsx"), "utf8")).toContain('fontFamily: `var(${fontVariable(body)}), "Tuti Symbols"`');
});
