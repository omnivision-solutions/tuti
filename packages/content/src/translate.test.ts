import { expect, test } from "vitest";

import type { Doc } from "./document";
import { glossaryProblems, segmentOfText, segmentsOf, translateDoc, translateText } from "./translate";

const link = { type: "link", attrs: { href: "https://example.com/billing", target: "_blank" } };
const doc: Doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2, id: "h" }, content: [{ type: "text", text: "Import events" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Click " },
        { type: "text", text: "Save", marks: [{ type: "bold" }] },
        { type: "text", text: " or run " },
        { type: "text", text: "tuti sync", marks: [{ type: "code" }] },
        { type: "text", text: ", then read " },
        { type: "text", text: "the billing ", marks: [link] },
        { type: "text", text: "guide", marks: [link, { type: "italic" }] },
        { type: "text", text: " & more." },
      ],
    },
    { type: "codeBlock", attrs: { language: "sh" }, content: [{ type: "text", text: "echo hello" }] },
    { type: "image", attrs: { mediaId: "m1", alt: "The Save button", w: 10, h: 10 } },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] }] },
    { type: "paragraph", content: [{ type: "text", text: "npm i", marks: [{ type: "code" }] }] },
  ],
};

test("a document's text becomes tagged segments; code, code blocks and text without words aren't sent", () => {
  expect(segmentsOf(doc).segments).toEqual([
    { id: "1", text: "Import events" },
    { id: "2", text: "Click <b1>Save</b1> or run <x2/>, then read <a3>the billing <i4>guide</i4></a3> &amp; more." },
    { id: "3", text: "The Save button" },
    { id: "4", text: "First" },
  ]);
});

test("a translation keeps every block, attribute and mark; tags may move to fit the word order", () => {
  const { apply } = segmentsOf(doc);
  const { doc: out, problems } = apply({
    "1": "Termine importieren",
    "2": "Lies <a3>die <i4>Anleitung</i4> zur Abrechnung</a3>, nachdem du <b1>Speichern</b1> klickst oder <x2/> ausführst &amp; mehr.",
    "3": "Die Schaltfläche Speichern",
    "4": "Erstens",
  });
  expect(problems).toEqual([]);
  expect(out.content![0]).toEqual({ type: "heading", attrs: { level: 2, id: "h" }, content: [{ type: "text", text: "Termine importieren" }] });
  expect(out.content![1]!.content).toEqual([
    { type: "text", text: "Lies " },
    { type: "text", text: "die ", marks: [link] },
    { type: "text", text: "Anleitung", marks: [link, { type: "italic" }] },
    { type: "text", text: " zur Abrechnung", marks: [link] },
    { type: "text", text: ", nachdem du " },
    { type: "text", text: "Speichern", marks: [{ type: "bold" }] },
    { type: "text", text: " klickst oder " },
    { type: "text", text: "tuti sync", marks: [{ type: "code" }] },
    { type: "text", text: " ausführst & mehr." },
  ]);
  expect(out.content![2]).toEqual(doc.content![2]);
  expect(out.content![3]!.attrs).toEqual({ mediaId: "m1", alt: "Die Schaltfläche Speichern", w: 10, h: 10 });
  expect(out.content![5]).toEqual(doc.content![5]);
  // The source is untouched.
  expect(doc.content![0]!.content![0]!.text).toBe("Import events");
});

test.each([
  ["a tag dropped", "Klicke Speichern oder <x2/>, <a3>die <i4>Anleitung</i4></a3>.", "<b1> is missing"],
  ["a placeholder dropped", "Klicke <b1>Speichern</b1>, <a3>die <i4>Anleitung</i4></a3>.", "placeholder <x2/> is missing"],
  ["tags crossed", "<b1>Klicke <a3>Speichern</b1> <i4>x</i4></a3> <x2/>", "</b1> closes a tag that isn't the innermost open one"],
  ["a tag emptied", "<b1></b1> <x2/> <a3>die <i4>Anleitung</i4></a3>", "<b1> is empty"],
  ["a tag repeated", "<b1>a</b1><b1>b</b1> <x2/> <a3>die <i4>Anleitung</i4></a3>", "<b1> is unknown or repeated"],
  ["a tag made up", "<b1>a</b1> <x2/> <a3>die <i4>Anleitung</i4></a3> <script>", "it has a tag that isn't in the source"],
])("%s keeps the source text and says why", (_, translated, reason) => {
  const { apply } = segmentsOf(doc);
  const { doc: out, problems } = apply({ "2": translated });
  expect(problems).toContainEqual({ id: "2", reason });
  expect(out.content![1]).toEqual(doc.content![1]);
});

test("glossary terms must come out as set, as whole words, and in scripts without spaces", () => {
  const glossary = [{ term: "Autopilot" }, { term: "board", translation: "Board" }, { term: "ボード" }];
  expect(glossaryProblems("Autopilot moves the <b1>board</b1>", "Der Autopilot verschiebt das <b1>Brett</b1>", glossary)).toEqual(['"board" must be translated as "Board"']);
  expect(glossaryProblems("Autopilots", "Autopiloten", glossary)).toEqual([]);
  expect(glossaryProblems("ボードを開く", "Open the panel", glossary)).toEqual(['"ボード" must stay "ボード"']);
});

test("plain text keeps its line breaks, links, addresses and code exactly", () => {
  const text = "Hi, the export at https://acme.com/export?id=4 fails.\nRun `tuti sync` or mail ops@acme.com.";
  const { segment, apply } = segmentOfText(text);
  expect(segment.text).toBe("Hi, the export at <x1/> fails.<br/>Run <x2/> or mail <x3/>.");
  expect(apply("Hallo, der Export unter <x1/> schlägt fehl.<br/>Führe <x2/> aus oder schreib an <x3/>.")).toBe(
    "Hallo, der Export unter https://acme.com/export?id=4 schlägt fehl.\nFühre `tuti sync` aus oder schreib an ops@acme.com.",
  );
  expect(apply("Hallo <x1/>.")).toEqual({ id: "1", reason: "a placeholder is missing" });
});

test("only segments the memory doesn't have are sent; a broken reply is asked again once with the reason", async () => {
  const asked: string[] = [];
  const replies = [
    JSON.stringify({ segments: { "2": "Klicke Speichern <x2/> <a3>die <i4>Anleitung</i4></a3>", "3": "Bild", "4": "Erstens" } }),
    JSON.stringify({ segments: { "2": "Klicke <b1>Speichern</b1> <x2/> <a3>die <i4>Anleitung</i4></a3>" } }),
  ];
  const result = await translateDoc(doc, {
    to: "de",
    memory: { "Import events": "Termine importieren" },
    ask: async (_, user) => {
      asked.push(user);
      return replies.shift()!;
    },
  });
  expect(asked).toHaveLength(2);
  expect(asked[0]).not.toContain("Import events");
  expect(asked[1]).toContain("- 2: its tags and placeholders don't match the source's");
  expect(result.problems).toEqual([]);
  expect(result.doc.content![0]!.content![0]!.text).toBe("Termine importieren");
  expect(result.memory["Import events"]).toBe("Termine importieren");
  expect(Object.keys(result.memory)).toHaveLength(4);
});

test("a message's language comes back with its translation", async () => {
  const out = await translateText("Hola, no puedo entrar", { to: "en", ask: async () => '```json\n{"language": "es", "segments": {"1": "Hi, I can\'t sign in"}}\n```' });
  expect(out).toEqual({ text: "Hi, I can't sign in", detected: "es" });
});

test("a translated glossary term may be inflected", () => {
  expect(glossaryProblems("Open the board", "Otwórz ustawienia tablicy", [{ term: "board", translation: "tablica" }])).toEqual([]);
});

test("a segment left in the source language is asked again", async () => {
  const one: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Readers vote on posts they like." }] }] };
  const replies = ['{"segments": {"1": "Readers vote on posts they like."}}', '{"segments": {"1": "Leser stimmen für Beiträge ab."}}'];
  const asked: string[] = [];
  const out = await translateDoc(one, { from: "English", to: "German", ask: async (_, user) => (asked.push(user), replies.shift()!) });
  expect(asked[1]).toContain("- 1: it isn't translated");
  expect(out.doc.content![0]!.content![0]!.text).toBe("Leser stimmen für Beiträge ab.");
});

test("crossed tags are asked again, and a translation that can't go back in is never remembered", async () => {
  const one: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Click " }, { type: "text", text: "Save", marks: [{ type: "bold" }] }, { type: "text", text: " to keep " }, { type: "text", text: "it", marks: [{ type: "italic" }] }] }] };
  const crossed = '{"segments": {"1": "Klicke <b1>Speichern <i2>es</b1></i2>"}}';
  const asked: string[] = [];
  const out = await translateDoc(one, { from: "English", to: "German", ask: async (_, user) => (asked.push(user), crossed) });
  expect(asked).toHaveLength(2);
  expect(asked[1]).toContain("closes a tag that isn't the innermost open one");
  expect(out.problems).toHaveLength(1);
  expect(out.memory).toEqual({});
  expect(out.doc).toEqual(one);
});

test("segments go in order, in batches of at most batchChars, and so do their retries", async () => {
  const many: Doc = { type: "doc", content: ["Alpha one two three", "Bravo one two three", "Charlie one two three", "Delta one two three"].map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) };
  const asked: string[][] = [];
  await translateDoc(many, {
    from: "English",
    to: "German",
    batchChars: 40,
    ask: async (_, user) => {
      const ids = Object.keys(JSON.parse(user.split("\n\n")[0]!) as object);
      asked.push(ids);
      // The first pass leaves every segment untranslated, so all are asked again.
      return JSON.stringify({ segments: Object.fromEntries(ids.map((id) => [id, asked.length <= 2 ? ["Alpha one two three", "Bravo one two three", "Charlie one two three", "Delta one two three"][Number(id) - 1] : `Übersetzt ${id}`])) });
    },
  });
  expect(asked).toEqual([
    ["1", "2"],
    ["3", "4"],
    ["1", "2"],
    ["3", "4"],
  ]);
});
