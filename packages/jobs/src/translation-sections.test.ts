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
  const { sections: edited } = editedSections(version, doc(["", "Einleitung"], ["Einrichtung", "Selbst installieren"], ["Extra", "Von uns"], ["Abrechnung", "Mit Karte zahlen"]), source);
  // Known again by text, then heading: Setup edited, the new one added, Billing as it was.
  expect(edited.map(({ meta }) => [meta.key?.split("\u001f")[0] ?? null, !!meta.own])).toEqual([
    ["", false],
    ["Setup", true],
    [null, true],
    ["Billing", false],
  ]);
  // English changes everywhere: the team's sections stay, the rest take the new translation.
  const v2 = doc(["", "Intro!"], ["Setup", "Install it now"], ["Billing", "Pay by card or invoice"]);
  const source2 = sourceSections(v2);
  const next = withTranslation(edited, doc(["", "Einleitung!"], ["Einrichtung", "Jetzt installieren"], ["Abrechnung", "Karte oder Rechnung"]), source2);
  expect(texts(docOfSections(next))).toEqual(["Einleitung!", "Einrichtung", "Selbst installieren", "Extra", "Von uns", "Abrechnung", "Karte oder Rechnung"]);
  // Those the team owns whose English changed are behind.
  expect(behindSections(next, source2).map((key) => key.split("\u001f")[0])).toEqual(["Setup"]);
});

test("`only`: just those sections take the new translation (a version the team writes, updating what it asked for)", () => {
  const source = sourceSections(v1);
  const version = versionSections(de1, [], source);
  const billing = source[2]!.key;
  const next = withTranslation(version, doc(["", "NEU"], ["NEU", "NEU"], ["Abrechnung", "Karte oder Rechnung"]), source, { only: new Set([billing]) });
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Installieren", "Abrechnung", "Karte oder Rechnung"]);
});

test("a section whose source section went goes, unless it's the team's", () => {
  const source = sourceSections(v1);
  const version = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Unseres"], ["Abrechnung", "Mit Karte zahlen"]), source).sections;
  const v2 = doc(["", "Intro"]);
  const next = withTranslation(version, doc(["", "Einleitung"]), sourceSections(v2));
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Unseres"]);
  expect(behindSections(next, sourceSections(v2)).map((key) => key.split("\u001f")[0])).toEqual(["Setup"]);
});

test("published on a version kept up to date, the team's edits give way only where their source changed, kept ones never", () => {
  const source = sourceSections(v1);
  const edited = editedSections(versionSections(de1, [], source), doc(["", "Hallo"], ["Einrichtung", "Unsere"], ["Abrechnung", "Mit Karte zahlen"]), source).sections;
  // Setup's edit kept over a newer translation.
  const published = edited.map((section, i) => (i === 1 ? { ...section, meta: { ...section.meta, kept: true as const } } : section));
  const v2 = doc(["", "Intro!"], ["Setup", "Install it now"], ["Billing", "Pay by card"]);
  const next = withTranslation(published, doc(["", "Einleitung!"], ["Einrichtung", "Jetzt installieren"], ["Abrechnung", "Mit Karte zahlen"]), sourceSections(v2), { published: true });
  // The intro's English changed: the edit goes. Setup's was kept: it stays. Billing's English didn't change: as it was.
  expect(texts(docOfSections(next))).toEqual(["Einleitung!", "Einrichtung", "Unsere", "Abrechnung", "Mit Karte zahlen"]);
  // Not so in a draft: every edit stays.
  expect(texts(docOfSections(withTranslation(published, doc(["", "Einleitung!"], ["Einrichtung", "Jetzt installieren"], ["Abrechnung", "Mit Karte zahlen"]), sourceSections(v2))))).toContain("Hallo");
});

test("a draft written before the version's first translation lines up with the source by position", () => {
  const source = sourceSections(v1);
  const drafted = editedSections([], de1, source).sections;
  expect(drafted.map(({ meta }) => meta.key)).toEqual(source.map(({ key }) => key));
  // Translated later: no section twice.
  expect(texts(docOfSections(withTranslation(drafted, de1, source)))).toEqual(texts(de1));
});

test("`only`: a version the team writes keeps its sections whose source went, but those it asked for", () => {
  const source = sourceSections(v1);
  const version = versionSections(de1, [], source);
  const v2 = doc(["", "Intro"], ["Setup", "Install it"]);
  const billing = source[2]!.key;
  expect(texts(docOfSections(withTranslation(version, doc(["", "NEU"], ["NEU", "NEU"]), sourceSections(v2), { only: new Set() })))).toEqual(texts(de1));
  expect(texts(docOfSections(withTranslation(version, doc(["", "NEU"], ["NEU", "NEU"]), sourceSections(v2), { only: new Set([billing]) })))).toEqual(texts(de1).slice(0, 3));
});

test("published on a version kept up to date, an edit whose source section was renamed or removed goes, unless kept", () => {
  const source = sourceSections(v1);
  const edited = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Unsere Abrechnung"]), source).sections;
  // English renames "Billing" to "Payments": its key is gone.
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Payments", "Pay by card"]);
  const translated = doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Zahlungen", "Mit Karte zahlen"]);
  expect(texts(docOfSections(withTranslation(edited, translated, sourceSections(v2), { published: true })))).toEqual(texts(translated));
  // Kept, it stays (behind); in a draft, it stays too.
  const kept = edited.map((section, i) => (i === 2 ? { ...section, meta: { ...section.meta, kept: true as const } } : section));
  expect(texts(docOfSections(withTranslation(kept, translated, sourceSections(v2), { published: true })))).toContain("Unsere Abrechnung");
  expect(texts(docOfSections(withTranslation(edited, translated, sourceSections(v2))))).toContain("Unsere Abrechnung");
});

test("an edit of a section translated from older source text is behind: it keeps the hash of what it was edited from", () => {
  const old = sourceSections(v1);
  const version = versionSections(de1, [], old);
  // English Billing changed since that translation (the new one not made yet).
  const now = sourceSections(doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card or invoice"]));
  const edited = editedSections(version, doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen!"]), now).sections;
  expect(behindSections(edited, now).map((key) => key.split("\u001f")[0])).toEqual(["Billing"]);
});

test("a section the team inserts in the middle is known as added: nothing after it shifts, nothing is lost or doubled", () => {
  const source = sourceSections(v1);
  const { sections: edited, removed } = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Hinweis", "Von uns"], ["Abrechnung", "Mit Karte zahlen"]), source);
  expect(removed).toEqual([]);
  expect(edited.map(({ meta }) => meta.key?.split("\u001f")[0] ?? null)).toEqual(["", "Setup", null, "Billing"]);
  // English changes Billing: the new translation there, the team's section where it put it.
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by invoice"]);
  const next = withTranslation(edited, doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Per Rechnung"]), sourceSections(v2));
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Installieren", "Hinweis", "Von uns", "Abrechnung", "Per Rechnung"]);
});

test("a section the team deletes from the middle is recorded as taken out: the job doesn't put it back", () => {
  const source = sourceSections(v1);
  const { sections: edited, removed } = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Abrechnung", "Mit Karte zahlen"]), source);
  expect(removed.map((key) => key.split("\u001f")[0])).toEqual(["Setup"]);
  expect(edited.map(({ meta }) => meta.key?.split("\u001f")[0] ?? null)).toEqual(["", "Billing"]);
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by invoice"]);
  const next = withTranslation(edited, doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Per Rechnung"]), sourceSections(v2), { removed: new Set(removed) });
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Abrechnung", "Per Rechnung"]);
});

test("an intro edited in the same save as a section added keeps its source section: nothing taken out, nothing detached", () => {
  const source = sourceSections(v1);
  const { sections: edited, removed } = editedSections(versionSections(de1, [], source), doc(["", "Hallo zusammen"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"], ["FAQ", "Fragen"]), source);
  expect(removed).toEqual([]);
  expect(edited.map(({ meta }) => [meta.key?.split("\u001f")[0] ?? null, !!meta.own])).toEqual([
    ["", true],
    ["Setup", false],
    ["Billing", false],
    [null, true],
  ]);
  // A heading reworded in the same save as a section added: still the same section.
  const reworded = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Zahlung", "Mit Karte zahlen!"], ["FAQ", "Fragen"]), source);
  expect(reworded.sections.map(({ meta }) => meta.key?.split("\u001f")[0] ?? null)).toEqual(["", "Setup", "Billing", null]);
  expect(reworded.removed).toEqual([]);
});
