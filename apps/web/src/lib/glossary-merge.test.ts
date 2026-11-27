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

test("a teammate's word for another language taken beside the one typed here; their new term added; their removed one kept, marked", () => {
  const before: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { de: "Tafel" } },
    { term: "Old", keep: true, translations: {} },
  ];
  const theirs: GlossaryTermInput[] = [
    { term: "Board", keep: false, translations: { de: "Tafel", fr: "Planche" } },
    { term: "Zeta", keep: true, translations: {} },
  ];
  expect(mergeMeanwhile([row("Board", { de: "Planke" }), row("Old", {}, true)], before, theirs, key)).toEqual([
    { ...row("Board", { de: "Planke", fr: "Planche" }), meanwhile: "Changed meanwhile" },
    { ...row("Old", {}, true), meanwhile: "Removed meanwhile" },
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

