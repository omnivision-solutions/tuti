import { expect, test } from "vitest";

import type { GlossaryTermInput } from "@/server/glossary";

import { mergeMeanwhile, type MergeRow } from "./glossary-merge";

const key = () => "new";
const row = (term: string, translations: Record<string, string>, keep = false): MergeRow => ({ key: term, term, keep, translations });

test("a term a teammate made Never translated while words were typed for it here: the typed words and the switch stay, marked", () => {
  const before = [{ term: "Board", keep: false, translations: { de: "Tafel" } }];
  const theirs = [{ term: "Board", keep: true, translations: {} }];
  expect(mergeMeanwhile([row("Board", { de: "Brett" })], before, theirs, key)).toEqual([{ ...row("Board", { de: "Brett" }), meanwhile: "Changed meanwhile" }]);
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
  expect(mergeMeanwhile([row("zeta", { de: "Zeta" })], [], theirs, key)).toEqual([{ ...row("zeta", { de: "Zeta", fr: "Zêta" }), meanwhile: "Changed meanwhile" }]);
  // The same on both sides: nothing to look at.
  expect(mergeMeanwhile([row("Zeta", { de: "Zett", fr: "Zêta" })], [], theirs, key)).toEqual([row("Zeta", { de: "Zett", fr: "Zêta" })]);
});

