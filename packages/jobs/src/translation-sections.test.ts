import type { Doc } from "@tuti/content";
import { expect, test } from "vitest";

import { behindSections, docOfSections, editedSections, sourceSections, versionSections, withTranslation } from "./translation-sections";

/** A document of sections: [heading, text] each ("" for the part before the first heading). */
const doc = (...parts: [string, string][]): Doc => ({
  type: "doc",
  content: parts.flatMap(([heading, text]) => [
    ...(heading ? [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] }] : []),
    { type: "paragraph", content: [{ type: "text", text }] },
  ]),
});
const texts = (d: Doc) => (d.content ?? []).map((block) => block.content?.[0]?.text);

const v1 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]);
const de1 = doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);

test("a version with no metadata yet lines up with the source by position, none of it the team's", () => {
  const source = sourceSections(v1);
  const version = versionSections(de1, [], source);
  expect(version.map(({ meta }) => meta)).toEqual(source.map(({ key, hash }) => ({ key, hash })));
  expect(behindSections(version, source)).toEqual([]);
});

test("the new translation replaces every section but those the team owns and those it added", () => {
  const source = sourceSections(v1);
  const version = versionSections(de1, [], source);
  // The team edits Setup and adds a section after it.
  const edited = editedSections(version, doc(["", "Einleitung"], ["Einrichtung", "Selbst installieren"], ["Extra", "Von uns"], ["Abrechnung", "Mit Karte zahlen"]), source);
  expect(edited.map(({ meta }) => [meta.key?.split("\u001f")[0] ?? null, !!meta.own])).toEqual([
    ["", false],
    ["Setup", true],
    // ponytail: by position, Billing's place now holds the added section, so it's edited and the old Billing one is added.
    ["Billing", true],
    [null, true],
  ]);
  // English changes everywhere: the team's sections stay, the rest take the new translation.
  const v2 = doc(["", "Intro!"], ["Setup", "Install it now"], ["Billing", "Pay by card or invoice"]);
  const source2 = sourceSections(v2);
  const next = withTranslation(edited, doc(["", "Einleitung!"], ["Einrichtung", "Jetzt installieren"], ["Abrechnung", "Karte oder Rechnung"]), source2);
  expect(texts(docOfSections(next))).toEqual(["Einleitung!", "Einrichtung", "Selbst installieren", "Extra", "Von uns", "Abrechnung", "Mit Karte zahlen"]);
  // Those the team owns whose English changed are behind.
  expect(behindSections(next, source2).map((key) => key.split("\u001f")[0])).toEqual(["Setup", "Billing"]);
});

test("`only`: just those sections take the new translation (a version the team writes, updating what it asked for)", () => {
  const source = sourceSections(v1);
  const version = versionSections(de1, [], source);
  const billing = source[2]!.key;
  const next = withTranslation(version, doc(["", "NEU"], ["NEU", "NEU"], ["Abrechnung", "Karte oder Rechnung"]), source, new Set([billing]));
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Installieren", "Abrechnung", "Karte oder Rechnung"]);
});

test("a section whose source section went goes, unless it's the team's", () => {
  const source = sourceSections(v1);
  const version = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Unseres"], ["Abrechnung", "Mit Karte zahlen"]), source);
  const v2 = doc(["", "Intro"]);
  const next = withTranslation(version, doc(["", "Einleitung"]), sourceSections(v2));
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Unseres"]);
  expect(behindSections(next, sourceSections(v2)).map((key) => key.split("\u001f")[0])).toEqual(["Setup"]);
});
