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
