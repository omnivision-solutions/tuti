import { isDeepStrictEqual } from "node:util";

import { diffBy } from "@tuti/content";

/**
 * Rule checks on an article edit (docs/plan.md, E5): plain functions of the article's Markdown before and after the
 * edit (one also reads the pull request's diff), no model. Lifted from the private writing evaluation, where each was
 * measured against graded edits: only "a section appended at the end" (under a new heading) agreed with the graders
 * closely enough to fail an edit by itself (ruleChecks' `fails`); the others are often right but often not, so they go to the Checks review as
 * hints (`hints`), never a verdict.
 */

const words = (text: string) => text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
const isHeading = (line: string) => /^#{1,6}\s/.test(line);
/** A line as compared: spacing doesn't make it another line. */
const norm = (line: string) => line.trim().replace(/\s+/g, " ");
const lines = (markdown: string) => markdown.split("\n").map(norm).filter(Boolean);

/** A line's sentences (a heading, a list item or a table row is one piece each, then split at sentence ends). */
const sentences = (line: string) =>
  isHeading(line) || line.startsWith("|")
    ? [line]
    : line
        .replace(/^([-*]|\d+[.)])\s+/, "")
        .split(/(?<=[.!?:])["”)]?\s+(?=[\p{Lu}"“*[(])/u)
        .map(norm)
        .filter(Boolean);

/** What the edit wrote (in the article after, not before), took out, and left as it was, by sentence. */
export function editOf(before: string, after: string): { added: string[]; removed: string[]; kept: string[] } {
  const was = lines(before).flatMap(sentences);
  const is = lines(after).flatMap(sentences);
  const wasSet = new Set(was);
  const isSet = new Set(is);
  return { added: is.filter((s) => !wasSet.has(s)), removed: was.filter((s) => !isSet.has(s)), kept: is.filter((s) => wasSet.has(s)) };
}

/**
 * Whether the edit leaves the article's sentences in their order and writes none it already had: nothing moved (steps
 * swapped, a paragraph moved) or copied, which editOf, comparing sentences as sets, can't see.
 */
function inPlace(before: string, after: string): boolean {
  const was = lines(before).flatMap(sentences);
  const had = new Set(was);
  return !diffBy(was, lines(after).flatMap(sentences), (sentence) => sentence).some((line) => line.kind === "added" && had.has(line.item));
}

/** On-screen labels and quoted words in a text: **bold**, "quoted" and “quoted”. */
export function labelsIn(text: string): string[] {
  return [...text.matchAll(/\*\*([^*\n]{2,80}?)\*\*|"([^"\n]{2,80}?)"|“([^”\n]{2,80}?)”/g)].map((m) => (m[1] ?? m[2] ?? m[3])!.trim().replace(/[.,:;]$/, "")).filter((label) => label.length >= 2);
}

/** A text without its labels, links' addresses and code: where a word like "now" is the screen's, not the writer's. */
const prose = (text: string) =>
  text
    .replace(/\*\*[^*\n]{1,80}?\*\*|"[^"\n]{1,80}?"|“[^”\n]{1,80}?”|`[^`\n]+`/g, " ")
    .replace(/\]\([^)]*\)/g, "]");

/**
 * Words that say how the product changed instead of how it works. "new" and "old" are left out: the evaluation found
 * them in too many timeless sentences ("create a new board") to be worth a hint.
 */
const CHANGELOG: [string, RegExp][] = [
  ["no longer", /\bno longer\b/i],
  ["used to", /\bused to (?!it\b)(?=\w)/i],
  ["has moved", /\b(?:has|have) (?:now |been )*(?:moved|renamed|replaced|removed|gone|changed)\b|\b(?:is|are) gone\b/i],
  ["now", /\bnow\b(?! (?:and|or) (?:then|again)\b)/i],
  ["previously", /\b(?:previously|formerly|before this|until now|from now on|any ?more|as before|instead of the old)\b/i],
  ["was called", /\b(?:was|were) (?:called|named|titled|labell?ed)\b/i],
];
/** Changelog words in the sentences the edit wrote (labels, quotes and code aside). */
export function changelogWords(before: string, after: string): { word: string; sentence: string }[] {
  return editOf(before, after).added.flatMap((sentence) => CHANGELOG.filter(([, pattern]) => pattern.test(prose(sentence))).map(([word]) => ({ word, sentence })));
}

/**
 * Lines the edit put after the article's old last line, which stays where it was (an article whose last paragraph was
 * rewritten in place has none), or null. Lines the article already had, only moved to the end, aren't an addition.
 */
export function appendedAtEnd(before: string, after: string): { lines: string[]; heading: string | null; subsection: boolean } | null {
  const was = lines(before);
  const is = lines(after);
  // Where the old article ended, in the new one: the first copy of its last line with everything else it kept before
  // it (as many of its other lines kept, by a line diff, as in the whole new text). A line repeated earlier, or a
  // copy of one at the end of what was added, doesn't mislead it. None: that line was rewritten in place, and nothing
  // was appended. What follows that copy was.
  const last = was.at(-1);
  if (last === undefined) {
    return null;
  }
  const kept = (upTo: number) => diffBy(was.slice(0, -1), is.slice(0, upTo), (text) => text).filter((line) => line.kind === "same").length;
  const all = kept(is.length);
  const end = is.findIndex((line, i) => line === last && kept(i) === all);
  if (end === -1 || end === is.length - 1) {
    return null;
  }
  const tail = is.slice(end + 1);
  const wasSet = new Set(was);
  if (tail.every((line) => wasSet.has(line))) {
    return null;
  }
  // A new section's heading is at the level of the article's last section heading or above (any heading, in an article
  // without one); a deeper one is a subsection of that last section, where the text may well belong.
  const level = (line: string) => /^#+/.exec(line)![0].length;
  // A title (#) isn't a section: what's under it is its sections (as headingOverLittle reads it).
  const lastSection = was.findLast((line) => isHeading(line) && !/^#\s/.test(line));
  const first = tail[0]!;
  const section = isHeading(first) && (lastSection === undefined || level(first) <= level(lastSection));
  return { lines: tail, heading: section ? first.replace(/^#+\s*/, "") : null, subsection: isHeading(first) && !section };
}

/** A new heading over less than this many words: where the evaluation lined up best with the graders' "heading over a sentence or two". */
export const HEADING_MIN_WORDS = 100;
/** Each heading the edit adds with under HEADING_MIN_WORDS words under it (to the next heading of its level or higher). */
export function headingOverLittle(before: string, after: string): { heading: string; words: number }[] {
  const had = new Set(lines(before).filter(isHeading).map((line) => line.replace(/^#+\s*/, "")));
  const is = lines(after);
  return is.flatMap((line, i) => {
    if (!isHeading(line) || /^#\s/.test(line) || had.has(line.replace(/^#+\s*/, ""))) {
      return [];
    }
    const level = /^#+/.exec(line)![0].length;
    const end = is.findIndex((next, j) => j > i && isHeading(next) && /^#+/.exec(next)![0].length <= level);
    const count = words(
      is
        .slice(i + 1, end === -1 ? undefined : end)
        .filter((next) => !isHeading(next))
        .join(" "),
    ).length;
    return count < HEADING_MIN_WORDS ? [{ heading: line.replace(/^#+\s*/, ""), words: count }] : [];
  });
}

/**
 * The writing rules' length budget in words (WRITING_RULES: a label word for word, a changed behaviour a sentence or
 * two, a paragraph only for a whole capability): an edit that writes more than SIZE_MAX_NET words more than it takes out,
 * or grows the article by a tenth and more than half that, is over it.
 */
export const SIZE_MAX_NET = 60;
export function sizeOf(before: string, after: string): { net: number; overBudget: boolean } {
  const edit = editOf(before, after);
  const net = words(edit.added.join(" ")).length - words(edit.removed.join(" ")).length;
  const article = words(before).length;
  return { net, overBudget: net > SIZE_MAX_NET || (article > 0 && net / article >= 0.1 && net > SIZE_MAX_NET / 2) };
}

const CUE = /\b(?:was|were|used to|formerly|previously|no longer|instead of|renamed|replaced|gone|removed|old|wherever|still says?|read it as)\b/i;
/** The diff's removed or added lines (file headers aside), as one text. */
const diffSide = (diff: string, sign: "+" | "-") =>
  diff
    .split("\n")
    .filter((line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3)))
    .map((line) => line.slice(1))
    .join("\n");
/** A label as code holds it: on-screen text, between quotes or tags, whole. */
const inCode = (code: string, label: string) => new RegExp(`(?<=["'\`>{(]|^|\\s)${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=["'\`<})]|$|[.,:]?\\s)`, "m").test(code) && /["'`>]/.test(code);

/**
 * Old text the edit contradicts and leaves in the article: a label (**bold** or quoted, of 4 characters or more) still
 * in a sentence the edit left, that the edit took out of a sentence it rewrote, that the edit itself names as the old one
 * ("it was called …"), or that the pull request's diff removed and added nowhere.
 */
export function leftContradictions(before: string, after: string, diff: string): { label: string; left: string }[] {
  const edit = editOf(before, after);
  const written = edit.added.join("\n").toLowerCase();
  const found = new Map<string, { label: string; left: string }>();
  const note = (label: string) => {
    const left = label.length >= 4 && !found.has(label.toLowerCase()) && edit.kept.find((sentence) => labelsIn(sentence).some((kept) => kept.toLowerCase() === label.toLowerCase()));
    if (left) {
      found.set(label.toLowerCase(), { label, left });
    }
  };
  for (const label of labelsIn(edit.removed.join("\n"))) {
    if (!written.includes(label.toLowerCase())) {
      note(label);
    }
  }
  const addedCode = diffSide(diff, "+");
  const removedCode = diffSide(diff, "-");
  for (const sentence of edit.added.filter((s) => CUE.test(prose(s)))) {
    for (const label of labelsIn(sentence)) {
      if (!addedCode.includes(label)) {
        note(label);
      }
    }
  }
  for (const label of new Set(labelsIn(edit.kept.join("\n")))) {
    if (inCode(removedCode, label) && !inCode(addedCode, label)) {
      note(label);
    }
  }
  return [...found.values()];
}

/** Labels, quoted words and `code` (where a path is written) in a text. */
const namesIn = (text: string) => [...labelsIn(text), ...[...text.matchAll(/`([^`\n]{2,120})`/g)].map((m) => m[1]!.trim())];
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name as a whole word or path, whatever its case: "Team" in `"Team"`, `>team<` or `/team/`, not in "Teams". */
const wholeName = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, "giu");
const hasName = (text: string, name: string) => wholeName(name).test(text);

/**
 * A rename or a moved page (docs/plan.md, E6): the label, quoted word or `code` path the edit took out (`from`) and the
 * one it put in (`to`), when that's all it did (the article reads the same, in the same order, with those names masked, as
 * a heading renamed does too), and the pull request's diff removed the old one and added the new one (any case), and
 * neither is on its other side too (kept or moved, not renamed). Null otherwise: one side missing, more than one name
 * either side, other words changed too, text moved or copied, the old name left anywhere, or a name the code change
 * doesn't show as renamed.
 */
export function renamed(before: string, after: string, diff: string): { from: string[]; to: string[] } | null {
  const edit = editOf(before, after);
  const lower = (list: string[]) => new Set(list.map((name) => name.toLowerCase()));
  const removed = namesIn(edit.removed.join("\n"));
  const added = namesIn(edit.added.join("\n"));
  const from = [...new Map(removed.filter((name) => !lower(added).has(name.toLowerCase())).map((name) => [name.toLowerCase(), name])).values()];
  const to = [...new Map(added.filter((name) => !lower(removed).has(name.toLowerCase())).map((name) => [name.toLowerCase(), name])).values()];
  // One name for one: with more, which old name became which new one can't be told (a swap, or names mapped to the
  // wrong places, masks the same), so it's measured as a correction or larger.
  if (from.length !== 1 || to.length !== 1) {
    return null;
  }
  // The whole article, in its order, the old name masked before and the new one after: anything else changed, moved
  // (even sentences that each carry the name) or left with the old name isn't a rename.
  const mask = (markdown: string, name: string) => lines(markdown).flatMap(sentences).map((sentence) => sentence.replace(wholeName(name), "\u0000"));
  if (!isDeepStrictEqual(mask(before, from[0]!), mask(after, to[0]!))) {
    return null;
  }
  const [removedCode, addedCode] = [diffSide(diff, "-"), diffSide(diff, "+")];
  // A name on both sides of the diff was kept or moved there, not renamed (labels on lines changed for something else).
  const [was, is] = [from[0]!, to[0]!];
  return hasName(removedCode, was) && !hasName(addedCode, was) && hasName(addedCode, is) && !hasName(removedCode, is) ? { from, to } : null;
}

/**
 * The most a small correction writes, and the most it takes out, in words (its changed sentences, whole): about two
 * sentences, the writing rules' "a changed behaviour is a sentence or two", well under SIZE_MAX_NET.
 */
export const SMALL_WORDS = 40;

/**
 * How big an edit is, for what may go out by itself (docs/plan.md, E6): a `rename` (or moved page, see renamed); a
 * `correction`, small and in place: it replaces text (takes some out, not only adds), leaves every heading as it was
 * (none added, renamed or taken out), moves and copies nothing (inPlace), appends nothing at the end, and writes and takes out at most SMALL_WORDS words
 * within sizeOf's budget; or `larger`, everything else, which asks first.
 */
export function editScope(before: string, after: string, diff: string): "rename" | "correction" | "larger" {
  if (renamed(before, after, diff)) {
    return "rename";
  }
  const edit = editOf(before, after);
  const headings = (markdown: string) => lines(markdown).filter(isHeading).join("\n");
  // Counted by occurrence (a sentence the article had twice, taken out once, is taken out): editOf's sets can't see it.
  const changed = diffBy(lines(before).flatMap(sentences), lines(after).flatMap(sentences), (sentence) => sentence);
  const wordsOf = (kind: "added" | "removed") => words(changed.filter((line) => line.kind === kind).map((line) => line.item).join(" ")).length;
  const small =
    edit.removed.length > 0 &&
    inPlace(before, after) &&
    headings(before) === headings(after) &&
    appendedAtEnd(before, after) === null &&
    !sizeOf(before, after).overBudget &&
    wordsOf("added") <= SMALL_WORDS &&
    wordsOf("removed") <= SMALL_WORDS;
  return small ? "correction" : "larger";
}

/** Why an edit with a section appended at the end fails by itself (said to the writer, for its one rewrite). */
export const APPENDED_FAILS =
  "It adds a new section after the article's last line instead of where a reader would look: change the sentences that are wrong where they stand, or add to the section the new text belongs in.";

const quote = (text: string) => `“${text.length > 160 ? `${text.slice(0, 157)}…` : text}”`;

/**
 * Every rule check on one edit: `fails` when one that's reliable enough fails it by itself (a section appended at the
 * end, under a new heading, unless it's the section for the end the writer is allowed, `added`), and the others'
 * findings as `hints`, one sentence each, for the Checks review. Text appended without a heading is a hint: it may be
 * the last section's next step, which belongs there.
 */
export function ruleChecks(before: string, after: string, { diff, added }: { diff: string; added: boolean }): { fails: string | null; hints: string[] } {
  const appended = added ? null : appendedAtEnd(before, after);
  const size = sizeOf(before, after);
  const hints = [
    ...(appended && !appended.heading ? [`Adds ${appended.subsection ? "a subsection" : "text"} after the article's last line: ${quote(appended.lines.join(" "))}.`] : []),
    ...changelogWords(before, after).map(({ word, sentence }) => `Says how the product changed ("${word}") in ${quote(sentence)}.`),
    ...headingOverLittle(before, after).map(({ heading, words: count }) => `Adds the heading ${quote(heading)} over ${count} words.`),
    ...(size.overBudget ? [`Writes ${size.net} words more than it takes out: past the budget for a label or a changed behaviour.`] : []),
    ...leftContradictions(before, after, diff).map(({ label, left }) => `May leave the old ${quote(label)} in ${quote(left)}.`),
  ];
  return { fails: appended?.heading ? APPENDED_FAILS : null, hints };
}
