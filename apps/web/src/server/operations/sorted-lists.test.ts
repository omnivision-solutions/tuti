import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

/**
 * The lists every new operation adds to stay sorted, one entry per line, so two pull requests adding different operations
 * don't both edit the end of a list and conflict.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sorted = (list: string[]) => [...list].sort();
const HOW = "Keep it sorted as `[...list].sort()` does (by character code: capitals before lowercase), one entry per line: put the new entry in its place, not at the end.";

test("operations/index.ts's imports are sorted by module, and each one's names", () => {
  const imports = [...read("./index.ts").matchAll(/^import (?:type )?\{([^}]*)\} from "([^"]+)";/gm)];
  const modules = imports.map(([, , from]) => from!);
  expect(modules, `operations/index.ts's imports: ${HOW}`).toEqual(sorted(modules));
  for (const [statement, names] of imports) {
    const list = names!.split(",").map((name) => name.trim()).filter(Boolean);
    expect(list, `${statement}: ${HOW}`).toEqual(sorted(list));
    if (list.length > 1) {
      expect(names, `${statement}: one name per line.`).toMatch(/^\n( {2}\w+,\n)+$/);
    }
  }
});

/** A table's top-level keys (two spaces in), from its first line to the `};` that closes it. */
function keys(file: string, start: string) {
  const text = read(file);
  const from = text.indexOf(start);
  return [...text.slice(from, text.indexOf("\n};", from)).matchAll(/^ {2}"([^"]+)":/gm)].map(([, key]) => key!);
}

test.each([
  ["../authorization.db.test.ts", "const procedures:"],
  ["./operations.db.test.ts", "const cases:"],
])("%s's table (%s) is sorted", (file, start) => {
  const list = keys(file, start);
  expect(list.length).toBeGreaterThan(10);
  expect(list, `${start.slice(0, -1)} in ${file}: ${HOW}`).toEqual(sorted(list));
});
