import { expect, test } from "vitest";

import type { GlossaryTermInput } from "@/server/glossary";

import { glossaryKey, mergeMeanwhile, type MergeRow, NEVER } from "./glossary-merge";

const key = () => "new";
const row = (term: string, translations: Record<string, string>, keep = false): MergeRow => ({ key: term, term, keep, translations });

test("a term a teammate made Never translated while words were typed for it here: the typed words and the switch stay, marked", () => {
  const before = [{ term: "Board", keep: false, translations: { de: "Tafel" } }];
  const theirs = [{ term: "Board", keep: true, translations: {} }];
  expect(mergeMeanwhile([row("Board", { de: "Brett" })], before, theirs, key)).toEqual([{ ...row("Board", { de: "Brett" }), meanwhile: "Changed meanwhile", theirs: { de: NEVER } }]);
});

test("a term a teammate made Never translated, nothing typed for it here: theirs taken, marked", () => {
  const before = [{ term: "Board", keep: false, translations: { de: "Tafel" } }];
  const theirs = [{ term: "Board", keep: true, translations: {} }];
  expect(mergeMeanwhile([row("Board", { de: "Tafel" })], before, theirs, key)).toEqual([{ ...row("Board", {}, true), meanwhile: "Changed meanwhile" }]);
});

test("a teammate's word for another language taken beside the one typed here; their new term added; their removed one, edited here, kept, marked", () => {
  const before: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { de: "Tafel" } },
    { term: "Old", keep: true, translations: {} },
  ];
  const theirs: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { de: "Tafel", fr: "Planche" } },
    { term: "Zeta", keep: true, translations: {} },
  ];
  expect(mergeMeanwhile([row("Board", { de: "Planke" }), row("Old", { de: "Alt" })], before, theirs, key)).toEqual([
    { ...row("Board", { de: "Planke", fr: "Planche" }), meanwhile: "Changed meanwhile" },
    { ...row("Old", { de: "Alt" }), meanwhile: "Removed meanwhile" },
    { key: "new", term: "Zeta", keep: true, translations: {}, meanwhile: "Added meanwhile" },
  ]);
});

test("a term added both here and by a teammate: their words fill the languages left empty here, what was typed stays, marked", () => {
  const theirs: GlossaryTermInput[] = [{ term: "Zeta", keep: false, translations: { de: "Zett", fr: "Zêta" } }];
  expect(mergeMeanwhile([row("zeta", { de: "Zeta" })], [], theirs, key)).toEqual([{ ...row("zeta", { de: "Zeta", fr: "Zêta" }), meanwhile: "Changed meanwhile", theirs: { de: "Zett" } }]);
  // The same on both sides: nothing to look at.
  expect(mergeMeanwhile([row("Zeta", { de: "Zett", fr: "Zêta" })], [], theirs, key)).toEqual([row("Zeta", { de: "Zett", fr: "Zêta" })]);
});

test("a term removed here that a teammate changed comes back, marked; one they didn't change stays removed", () => {
  const before: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { de: "Tafel" } },
    { term: "Old", keep: true, translations: {} },
  ];
  const theirs: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { de: "Brett" } },
    { term: "Old", keep: true, translations: {} },
  ];
  expect(mergeMeanwhile([], before, theirs, key)).toEqual([{ key: "new", term: "Board", keep: false, translations: { de: "Brett" }, meanwhile: "Changed meanwhile" }]);
});

test("a term renamed here that a teammate changed: the old one comes back beside the renamed row, marked", () => {
  const before: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Tafel" } }];
  const theirs: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Tafel", fr: "Planche" } }];
  expect(mergeMeanwhile([row("Boards", { de: "Tafel" })], before, theirs, key)).toEqual([
    row("Boards", { de: "Tafel" }),
    { key: "new", term: "Board", keep: false, translations: { de: "Tafel", fr: "Planche" }, meanwhile: "Changed meanwhile" },
  ]);
});

test("the same terms in another order, their languages too, are the same list to save", () => {
  const server: GlossaryTermInput[] = [
    { term: "Acme", keep: true, translations: {} },
    { term: "Board", keep: false, translations: { de: "Tafel", fr: "Planche" } },
  ];
  const page: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { fr: "Planche", de: "Tafel" } },
    { term: "Acme", keep: true, translations: {} },
  ];
  expect(glossaryKey(page)).toBe(glossaryKey(server));
  expect(JSON.parse(glossaryKey(page))).toEqual(server);
});

test("a word changed both here and by a teammate: the one typed here stays, theirs carried beside it, marked", () => {
  const before: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Tafel", fr: "Tableau" } }];
  const theirs: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Brett" } }];
  // German changed on both sides; French cleared there, kept here (not edited here: theirs taken, no conflict).
  expect(mergeMeanwhile([row("Board", { de: "Planke", fr: "Tableau" })], before, theirs, key)).toEqual([
    { ...row("Board", { de: "Planke" }), meanwhile: "Changed meanwhile", theirs: { de: "Brett" } },
  ]);
  // Both added it, with other German words.
  expect(mergeMeanwhile([row("Zeta", { de: "Zett" })], [], [{ term: "Zeta", keep: false, translations: { de: "Zeh" } }], key)).toEqual([
    { ...row("Zeta", { de: "Zett" }), meanwhile: "Changed meanwhile", theirs: { de: "Zeh" } },
  ]);
});

test("a term a teammate removed, untouched here: it goes (their removal wins), unmarked", () => {
  const before: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { de: "Tafel" } },
    { term: "Old", keep: true, translations: {} },
  ];
  const theirs: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Tafel" } }];
  expect(mergeMeanwhile([row("Board", { de: "Planke" }), row("Old", {}, true)], before, theirs, key)).toEqual([row("Board", { de: "Planke" })]);
});

test("Never translated set on one side only: their every changed word is carried, whichever side set it", () => {
  const before: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Tafel", fr: "Tableau" } }];
  // Made Never translated here; they changed German and French: both their words carried (shown under the term).
  const words: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Brett", fr: "Planche" } }];
  expect(mergeMeanwhile([row("Board", { de: "Tafel", fr: "Tableau" }, true)], before, words, key)).toEqual([
    { ...row("Board", { de: "Brett", fr: "Planche" }, true), meanwhile: "Changed meanwhile", theirs: { de: "Brett", fr: "Planche" } },
  ]);
  // They made it Never translated; German was edited here: every language whose word they dropped says so.
  const never: GlossaryTermInput[] = [{ term: "Board", keep: true, translations: {} }];
  expect(mergeMeanwhile([row("Board", { de: "Planke", fr: "Tableau" })], before, never, key)).toEqual([
    { ...row("Board", { de: "Planke" }), meanwhile: "Changed meanwhile", theirs: { de: NEVER, fr: NEVER } },
  ]);
});

test("a term added both here and there, Never translated on one side only: the other side's choice carried, marked", () => {
  // Never translated here; their words carried (shown under the term).
  expect(mergeMeanwhile([row("Zeta", {}, true)], [], [{ term: "Zeta", keep: false, translations: { de: "Zett" } }], key)).toEqual([
    { ...row("Zeta", { de: "Zett" }, true), meanwhile: "Changed meanwhile", theirs: { de: "Zett" } },
  ]);
  // Never translated there; beside each word typed here.
  expect(mergeMeanwhile([row("Zeta", { de: "Zett" })], [], [{ term: "Zeta", keep: true, translations: {} }], key)).toEqual([
    { ...row("Zeta", { de: "Zett" }), meanwhile: "Changed meanwhile", theirs: { de: NEVER } },
  ]);
});


test("a Never translated term's old words, still on screen but never saved, aren't edits: a teammate's removal or new words win", () => {
  // Saved Never translated; the row still holds the words it had before, in case it's turned off again.
  const hidden = row("Board", { de: "Tafel" }, true);
  const before: GlossaryTermInput[] = [{ term: "Board", keep: true, translations: {} }];
  // They removed it: it goes, not back as Removed meanwhile.
  expect(mergeMeanwhile([hidden], before, [], key)).toEqual([]);
  // They turned Never translated off and gave it a word: theirs, not the hidden one.
  const theirs: GlossaryTermInput[] = [{ term: "Board", keep: false, translations: { de: "Brett" } }];
  expect(mergeMeanwhile([hidden], before, theirs, key)).toEqual([{ ...row("Board", { de: "Brett" }), meanwhile: "Changed meanwhile" }]);
});
