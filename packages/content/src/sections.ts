import type { JSONContent } from "@tiptap/core";

import type { Doc } from "./document";
import { parseDoc, toPlainText } from "./document";

/**
 * An article's sections (docs/plan.md, V3): what's before the first heading, then each heading and what follows it up
 * to the next. Autopilot's edits are compared, merged and taken out by section, and the editor says which it changed.
 */

type Block = JSONContent;

/** JSON with its keys in one order, so a document read back from Postgres compares equal to the one written. */
const canon = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

export const sameDoc = (a: Doc, b: Doc) => canon(a.content ?? []) === canon(b.content ?? []);

/** The article's top-level sections in order: what's before the first heading, then each heading and what follows it up to the next. */
export function sections(blocks: Block[]): Block[][] {
  const out: Block[][] = [[]];
  for (const block of blocks) {
    if (block.type === "heading" && out.at(-1)!.length > 0) {
      out.push([]);
    }
    out.at(-1)!.push(block);
  }
  return out.filter((section) => section.length > 0);
}

/**
 * Sections by key: the heading's text ("" before the first heading), numbered when one repeats. ponytail: a renamed
 * heading is a different section (taken out and added), so an edit to it and to its old name count as the same one.
 */
export function keyed(doc: Doc): [string, Block[]][] {
  const seen = new Map<string, number>();
  return sections(doc.content ?? []).map((section) => {
    const head = section[0]!.type === "heading" ? toPlainText(section[0]!).trim() : "";
    const n = seen.get(head) ?? 0;
    seen.set(head, n + 1);
    return [`${head}\u0000${n}`, section];
  });
}

/** The sections that differ from `a` to `b`: changed, added or taken out. */
export function changedSections(a: Doc, b: Doc): Set<string> {
  const [x, y] = [new Map(keyed(a)), new Map(keyed(b))];
  return new Set([...new Set([...x.keys(), ...y.keys()])].filter((key) => canon(x.get(key)) !== canon(y.get(key))));
}

/**
 * `doc` with the sections named by `keys` as `from` has them: replaced where both have one, taken out where `from`
 * hasn't, and where only `from` has one, added after the section before it in `from` (first, if none is in `doc`).
 */
export function withSectionsOf(doc: Doc, from: Doc, keys: Set<string>): Doc {
  const theirs = keyed(from);
  const byKey = new Map(theirs);
  const result = keyed(doc).flatMap(([key, blocks]): [string, Block[]][] => (!keys.has(key) ? [[key, blocks]] : byKey.has(key) ? [[key, byKey.get(key)!]] : []));
  for (const [i, [key, blocks]] of theirs.entries()) {
    if (keys.has(key) && !result.some(([k]) => k === key)) {
      const before = theirs.slice(0, i).reverse().find(([k]) => result.some(([r]) => r === k));
      result.splice(before ? result.findIndex(([r]) => r === before[0]) + 1 : 0, 0, [key, blocks]);
    }
  }
  return { type: "doc", content: result.flatMap(([, blocks]) => blocks) };
}

/** Whether `b` keeps the sections `a` has in the same order (sections added or taken out aside). */
export function sameOrder(a: Doc, b: Doc): boolean {
  const [x, y] = [keyed(a).map(([key]) => key), keyed(b).map(([key]) => key)];
  const [inX, inY] = [x.filter((key) => y.includes(key)), y.filter((key) => x.includes(key))];
  return inX.every((key, i) => key === inY[i]);
}

/**
 * `ours` (an edit of `base`) applied by section onto `theirs` (another edit of `base`): the sections it changed,
 * added (after the one before it in `ours`) or took out. `theirs` still `base`: `ours` as it is. Null when both changed
 * one of the same sections, or `ours` moves sections around (a merge by section can't keep that).
 */
export function mergeSections(base: Doc, ours: Doc, theirs: Doc, { oursWin = false } = {}): Doc | null {
  if (sameDoc(base, theirs)) {
    return ours;
  }
  if (!sameOrder(base, ours)) {
    return null;
  }
  const mine = changedSections(base, ours);
  const others = changedSections(base, theirs);
  // Both changed a section alike: no conflict (it reads the same either way). `oursWin`: someone who saw `theirs` writes
  // over the sections both changed (merged by hand).
  const [inOurs, inTheirs] = [new Map(keyed(ours)), new Map(keyed(theirs))];
  if (!oursWin && [...mine].some((key) => others.has(key) && canon(inOurs.get(key)) !== canon(inTheirs.get(key)))) {
    return null;
  }
  const result = keyed(theirs);
  const ordered = keyed(ours);
  for (const key of mine) {
    const at = result.findIndex(([k]) => k === key);
    const section = ordered.find(([k]) => k === key);
    if (!section) {
      // (Already gone when `theirs` took it out too.)
      if (at !== -1) {
        result.splice(at, 1);
      }
    } else if (at !== -1) {
      result[at] = section;
    } else {
      // After the section before it in `ours` that's there, or first.
      const before = ordered.slice(0, ordered.indexOf(section)).reverse().find(([k]) => result.some(([r]) => r === k));
      result.splice(before ? result.findIndex(([r]) => r === before[0]) + 1 : 0, 0, section);
    }
  }
  return { type: "doc", content: result.flatMap(([, blocks]) => blocks) };
}

/** Whether two sections (or none) read the same. */
export const sameSection = (a: Block[] | null | undefined, b: Block[] | null | undefined) => canon(a ?? null) === canon(b ?? null);

/**
 * An article's text as it's stored (links cut to their href, defaults dropped): the editor's JSON has more, so both sides
 * go through this before sections are compared, else an untouched section with a link reads as changed.
 */
export function storedArticle(doc: Doc): Doc {
  const parsed = parseDoc("article", doc);
  return parsed.ok ? parsed.doc : doc;
}

/** The sections the editor's user changed from `had` to `text` (both as stored): what its save sends, by key. */
export const editedSections = (had: Doc, text: Doc): string[] => [...changedSections(storedArticle(had), storedArticle(text))];
