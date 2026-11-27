import type { Doc } from "@tuti/content";
import { expect, test } from "vitest";

import { behindSections, docOfSections, editedSections, metaOf, ownedByTeam, sourceSections, versionSections, withTranslation } from "./translation-sections";

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
  // A heading reworded (its text as it was) in the same save as a section added: still the same section.
  const renamed = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Zahlung", "Mit Karte zahlen"], ["FAQ", "Fragen"]), source);
  expect(renamed.sections.map(({ meta }) => meta.key?.split("\u001f")[0] ?? null)).toEqual(["", "Setup", "Billing", null]);
  expect(renamed.removed).toEqual([]);
  // A heading reworded alone between matched ones: still the same section.
  const reworded = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Zahlung", "Mit Karte zahlen!"]), source);
  expect(reworded.sections.map(({ meta }) => meta.key?.split("\u001f")[0] ?? null)).toEqual(["", "Setup", "Billing"]);
  expect(reworded.removed).toEqual([]);
});

test("a section added next to one rewritten (heading and text) never takes its place: both are the team's, nothing lost", () => {
  const source = sourceSections(v1);
  const { sections: edited, removed } = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["FAQ", "Fragen"], ["Zahlung", "Per Karte"]), source);
  // Two left over for one: neither is known as Billing; Billing counts as taken out.
  expect(edited.map(({ meta }) => meta.key?.split("\u001f")[0] ?? null)).toEqual(["", "Setup", null, null]);
  expect(removed.map((key) => key.split("\u001f")[0])).toEqual(["Billing"]);
  // English changes Billing: the team's sections stay, nothing doubled.
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by invoice"]);
  const next = withTranslation(edited, doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Per Rechnung"]), sourceSections(v2), { removed: new Set(removed) });
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Installieren", "FAQ", "Fragen", "Zahlung", "Per Karte"]);
});

test("a source intro added under the team's section at the top goes first: the text splits back into its sections", () => {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  const de = doc(["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const { sections: edited } = editedSections(versionSections(de, [], source), doc(["Hinweis", "Von uns"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), source);
  // English adds an intro.
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source2 = sourceSections(v2);
  const next = withTranslation(edited, doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), source2, { published: true });
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Hinweis", "Von uns", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
  // Read back, its sections are as written: the team's Hinweis still theirs.
  const back = versionSections(docOfSections(next), metaOf(next), source2);
  expect(back.map(({ meta }) => [meta.key?.split("\u001f")[0] ?? null, !!meta.own])).toEqual([
    ["", false],
    [null, true],
    ["Setup", false],
    ["Billing", false],
  ]);
});

test("the team's own intro at the top stands for an intro the source adds later: one section, theirs, behind it; their other edits kept", () => {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  const de = doc(["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  // The team writes an intro (no heading) and rewrites Billing.
  const edited: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Willkommen" }] }, ...doc(["Einrichtung", "Installieren"], ["Abrechnung", "Unsere Abrechnung"]).content!] };
  const { sections: ours } = editedSections(versionSections(de, [], source), edited, source);
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source2 = sourceSections(v2);
  const next = withTranslation(ours, doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), source2);
  expect(texts(docOfSections(next))).toEqual(["Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Unsere Abrechnung"]);
  // Read back as written: their intro behind the source's, their Billing still theirs.
  const back = versionSections(docOfSections(next), metaOf(next), source2);
  expect(back.map(({ meta }) => [meta.key?.split("\u001f")[0] ?? null, !!meta.own])).toEqual([
    ["", true],
    ["Setup", false],
    ["Billing", true],
  ]);
  expect(behindSections(back, source2).map((key) => key.split("\u001f")[0])).toEqual([""]);
});

test("the team's intro standing for the source's stays through later runs, and gives way when the team asks for that section", () => {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  const de = doc(["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const edited: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Willkommen" }] }, ...de.content!] };
  const { sections: ours } = editedSections(versionSections(de, [], source), edited, source);
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source2 = sourceSections(v2);
  const translated = doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const once = withTranslation(ours, translated, source2, { published: true });
  // English changes Billing: the published text keeps the team's intro.
  const v3 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by invoice"]);
  const twice = withTranslation(versionSections(docOfSections(once), metaOf(once), source2), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Per Rechnung"]), sourceSections(v3), { published: true });
  expect(texts(docOfSections(twice))).toEqual(["Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Per Rechnung"]);
  // A version the team writes, asking for the intro it lacks: its translation in, the team's own paragraph kept after it.
  const asked = withTranslation(ours, translated, source2, { only: new Set([source2[0]!.key]) });
  expect(texts(docOfSections(asked))).toEqual(["Einleitung", "Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
  expect(versionSections(docOfSections(asked), metaOf(asked), source2)).toHaveLength(3);
});

test("Update those sections: the sections asked for take the new translation, the team's or kept; the team's others stay", () => {
  const source = sourceSections(v1);
  const { sections: edited } = editedSections(versionSections(de1, [], source), doc(["", "Hallo"], ["Einrichtung", "Unsere"], ["Abrechnung", "Unsere Zahlung"]), source);
  // Billing kept over a newer translation; the intro and Setup the team's too.
  const ours = edited.map((section, i) => (i === 2 ? { ...section, meta: { ...section.meta, kept: true as const } } : section));
  const translated = doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const [setup, billing] = [source[1]!.key, source[2]!.key];
  // Kept up to date (no `only`): asked for Setup and Billing.
  const published = withTranslation(ours, translated, source, { published: true, asked: new Set([setup, billing]) });
  expect(texts(docOfSections(published))).toEqual(["Hallo", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
  // A version the team writes (`only`), in its draft: Billing asked for, Setup and the intro stay theirs.
  const draft = withTranslation(ours, translated, source, { only: new Set([billing]) });
  expect(texts(docOfSections(draft))).toEqual(["Hallo", "Einrichtung", "Unsere", "Abrechnung", "Mit Karte zahlen"]);
});

test("a section whose text was rewritten without its metadata (the previous release's job, in a deploy) isn't the team's any more", () => {
  const source = sourceSections(v1);
  const { sections: edited } = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Unsere Abrechnung"]), source);
  const kept = edited.map((section, i) => (i === 2 ? { ...section, meta: { ...section.meta, kept: true as const } } : section));
  const meta = metaOf(kept);
  // As written: Billing the team's, kept.
  expect(versionSections(docOfSections(kept), meta, source)[2]!.meta).toMatchObject({ own: true, kept: true });
  // Rewritten by a job that knows nothing of it: a translation, by position, nobody's.
  const rewritten = versionSections(de1, meta, source);
  expect(rewritten[2]!.meta).toEqual({ key: source[2]!.key, hash: source[2]!.hash });
  expect(rewritten[0]!.meta.key).toBe(source[0]!.key);
});

test("a section asked for, then taken out by the team while the job translated it, isn't put back: only what's still asked for overrides that", () => {
  const source = sourceSections(v1);
  const billing = source[2]!.key;
  // The team took Billing out after asking for it: the run started with it (`only`), it's no longer asked for (`asked`).
  const { sections: edited, removed } = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Einrichtung", "Installieren"]), source);
  expect(removed).toEqual([billing]);
  const next = withTranslation(edited, doc(["", "Einleitung 2"], ["Einrichtung", "Installieren 2"], ["Abrechnung", "Per Rechnung"]), source, { only: new Set([billing]), asked: new Set(), removed: new Set(removed) });
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Installieren"]);
});

test("kept up to date (no `only`): a section the team took out and then asked to update comes back with its new translation", () => {
  const source = sourceSections(v1);
  const setup = source[1]!.key;
  const { sections: edited, removed } = editedSections(versionSections(de1, [], source), doc(["", "Einleitung"], ["Abrechnung", "Mit Karte zahlen"]), source);
  expect(removed).toEqual([setup]);
  const next = withTranslation(edited, doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), source, { asked: new Set([setup]), removed: new Set(removed) });
  expect(texts(docOfSections(next))).toEqual(["Einleitung", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
});

test("Update those sections on a version kept up to date: the team's paragraph standing in for the source's intro stays after its translation", () => {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  const de = doc(["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const edited: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Willkommen" }] }, ...de.content!] };
  const { sections: ours } = editedSections(versionSections(de, [], source), edited, source);
  const v2 = doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source2 = sourceSections(v2);
  const translated = doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const once = withTranslation(ours, translated, source2, { published: true });
  // Update those sections, by default the ones behind (the intro): as articles.updateTranslation asks, its own flags gone.
  const introKey = source2[0]!.key;
  const asked = versionSections(docOfSections(once), metaOf(once), source2).map((part) =>
    part.meta.key === introKey ? { blocks: part.blocks, meta: { key: introKey, hash: part.meta.hash, standIn: part.meta.standIn } } : part,
  );
  const updated = withTranslation(asked, translated, source2, { published: true, asked: new Set([introKey]) });
  expect(texts(docOfSections(updated))).toEqual(["Einleitung", "Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
  // Read back as three sections, the intro the team's (its paragraph in it) and up to date.
  const back = versionSections(docOfSections(updated), metaOf(updated), source2);
  expect(back).toHaveLength(3);
  expect(behindSections(back, source2)).toEqual([]);
  // A later new intro replaces only the translation: the team's paragraph stays.
  const v3 = doc(["", "New intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]);
  const again = withTranslation(back, doc(["", "Neue Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), sourceSections(v3), { published: true });
  expect(texts(docOfSections(again))).toEqual(["Neue Einleitung", "Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
});

test("a section of the team's with no heading, standing for a source section that has one, stays first when the source moves it later", () => {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  // A version the team writes: its first section has no heading, so by position it stands for Setup.
  const ours: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Unsere Einrichtung" }] }, ...doc(["Abrechnung", "Mit Karte zahlen"]).content!] };
  const list = versionSections(ours, [], source);
  expect(list[0]!.meta.key).toBe(source[0]!.key);
  // English moves Billing ahead of Setup; the team updates only Billing.
  const v2 = doc(["Billing", "Pay by card or invoice"], ["Setup", "Install it"]);
  const source2 = sourceSections(v2);
  const billing = source2.find((section) => section.key.startsWith("Billing"))!.key;
  const out = withTranslation(list, doc(["Abrechnung", "Per Karte oder Rechnung"], ["Einrichtung", "Installieren"]), source2, { only: new Set([billing]) });
  expect(texts(docOfSections(out))).toEqual(["Unsere Einrichtung", "Abrechnung", "Per Karte oder Rechnung"]);
  // Read back as written: its sections and what each stands for kept.
  const back = versionSections(docOfSections(out), metaOf(out), source2);
  expect(back.map(({ meta }) => meta.key)).toEqual(out.map(({ meta }) => meta.key));
});

/** A version kept up to date where the team's "Willkommen" stands in for an intro English added, updated (Update those sections). */
function standInUpdated() {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  const de = doc(["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const edited: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Willkommen" }] }, ...de.content!] };
  const { sections: ours } = editedSections(versionSections(de, [], source), edited, source);
  const source2 = sourceSections(doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]));
  const translated = doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const once = withTranslation(ours, translated, source2, { published: true });
  const introKey = source2[0]!.key;
  const asked = versionSections(docOfSections(once), metaOf(once), source2).map((part) =>
    part.meta.key === introKey ? { blocks: part.blocks, meta: { key: introKey, hash: part.meta.hash, standIn: part.meta.standIn } } : part,
  );
  const updated = withTranslation(asked, translated, source2, { published: true, asked: new Set([introKey]) });
  return versionSections(docOfSections(updated), metaOf(updated), source2);
}

test("the team's paragraph standing in for an intro stays when English takes its intro out again", () => {
  const back = standInUpdated();
  const v3 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const gone = withTranslation(back, doc(["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), sourceSections(v3), { published: true });
  expect(texts(docOfSections(gone))).toEqual(["Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
});

test("the team editing their own paragraph after the intro's translation keeps it standing in: a later intro replaces only the intro's", () => {
  const back = standInUpdated();
  const source2 = sourceSections(doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]));
  const edited: Doc = { ...docOfSections(back) };
  edited.content = structuredClone(edited.content);
  edited.content![1]!.content![0]!.text = "Herzlich willkommen";
  const { sections: ours } = editedSections(back, edited, source2);
  const v3 = doc(["", "New intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]);
  const again = withTranslation(ours, doc(["", "Neue Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), sourceSections(v3), { published: true });
  expect(texts(docOfSections(again))).toEqual(["Neue Einleitung", "Herzlich willkommen", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
});

test("a section of the team's with no heading, merged into the intro English added after moving it, still stands for its own section", () => {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  // A version the team writes: its first section has no heading, so it stands for Setup.
  const ours: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Unsere Einrichtung" }] }, ...doc(["Abrechnung", "Mit Karte zahlen"]).content!] };
  const list = ownedByTeam(versionSections(ours, [], source));
  // English adds an intro and moves Setup after Billing; the team updates the intro.
  const source2 = sourceSections(doc(["", "Intro"], ["Billing", "Pay by card"], ["Setup", "Install it"]));
  const intro = source2[0]!.key;
  const out = withTranslation(list, doc(["", "Einleitung"], ["Abrechnung", "Mit Karte zahlen"], ["Einrichtung", "Installieren"]), source2, { only: new Set([intro]) });
  expect(texts(docOfSections(out))).toEqual(["Einleitung", "Unsere Einrichtung", "Abrechnung", "Mit Karte zahlen"]);
  // Read back: Setup isn't missing (its text is in the section at the top), and nothing is there twice.
  const back = versionSections(docOfSections(out), metaOf(out), source2);
  expect(behindSections(back, source2, { missing: true }).filter((key) => key.startsWith("Setup"))).toEqual([]);
  const again = withTranslation(back, doc(["", "Einleitung"], ["Abrechnung", "Mit Karte zahlen"], ["Einrichtung", "Installieren"]), source2, { only: new Set([intro]) });
  expect(texts(docOfSections(again))).toEqual(["Einleitung", "Unsere Einrichtung", "Abrechnung", "Mit Karte zahlen"]);
});

test("a version the team writes keeps its intro standing in whole when English takes the intro out and the team updates another section", () => {
  const v1 = doc(["Setup", "Install it"], ["Billing", "Pay by card"]);
  const source = sourceSections(v1);
  const de = doc(["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]);
  const edited: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Willkommen" }] }, ...de.content!] };
  const { sections: ours } = editedSections(versionSections(de, [], source), edited, source, { automatic: false });
  const source2 = sourceSections(doc(["", "Intro"], ["Setup", "Install it"], ["Billing", "Pay by card"]));
  const intro = source2[0]!.key;
  // The team asks for the intro: its translation, their paragraph after it.
  const withIntro = withTranslation(ownedByTeam(ours), doc(["", "Einleitung"], ["Einrichtung", "Installieren"], ["Abrechnung", "Mit Karte zahlen"]), source2, { only: new Set([intro]) });
  expect(texts(docOfSections(withIntro))).toEqual(["Einleitung", "Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Mit Karte zahlen"]);
  // English takes the intro out and changes Billing; the team updates only Billing: the top section is theirs to keep, whole.
  const source3 = sourceSections(doc(["Setup", "Install it"], ["Billing", "Pay by invoice"]));
  const billing = source3.find((section) => section.key.startsWith("Billing"))!.key;
  const back = ownedByTeam(versionSections(docOfSections(withIntro), metaOf(withIntro), source2));
  const out = withTranslation(back, doc(["Einrichtung", "Installieren"], ["Abrechnung", "Per Rechnung"]), source3, { only: new Set([billing]) });
  expect(texts(docOfSections(out))).toEqual(["Einleitung", "Willkommen", "Einrichtung", "Installieren", "Abrechnung", "Per Rechnung"]);
});
