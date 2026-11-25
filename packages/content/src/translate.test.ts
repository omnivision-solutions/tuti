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
  const text = "Hi, the export at https://acme.com/export?id=4 fails.\nRun `tuti sync` or mail e2e-ops@example.com.";
  const { segment, apply } = segmentOfText(text);
  expect(segment.text).toBe("Hi, the export at <x1/> fails.<br/>Run <x2/> or mail <x3/>.");
  expect(apply("Hallo, der Export unter <x1/> schlägt fehl.<br/>Führe <x2/> aus oder schreib an <x3/>.")).toBe(
    "Hallo, der Export unter https://acme.com/export?id=4 schlägt fehl.\nFühre `tuti sync` aus oder schreib an e2e-ops@example.com.",
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
  expect(asked[1]).toContain("- 2: its tags, placeholders and line breaks don't match the source's");
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

test("what a placeholder stands for goes back exactly, escaped characters and all", () => {
  const { segment, apply } = segmentOfText("See https://x.com/?a=1&amp;b=2 and `&lt;br&gt;` & more");
  expect(segment.text).toBe("See <x1/> and <x2/> &amp; more");
  expect(apply("Siehe <x1/> und <x2/> &amp; mehr")).toBe("Siehe https://x.com/?a=1&amp;b=2 und `&lt;br&gt;` & mehr");
});

test("a word that only starts with a glossary term doesn't use it", () => {
  expect(glossaryProblems("Postpone the release", "Verschiebe die Veröffentlichung", [{ term: "Post", translation: "Beitrag" }])).toEqual([]);
  expect(glossaryProblems("Merge two posts", "Zwei Einträge zusammenführen", [{ term: "Post", translation: "Beitrag" }])).toEqual(['"Post" must be translated as "Beitrag"']);
});

test("a remembered translation that breaks a glossary term added since is sent again", async () => {
  const one: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Open the board" }] }] };
  const asked: string[] = [];
  const out = await translateDoc(one, {
    from: "English",
    to: "German",
    glossary: [{ term: "board", translation: "Board" }],
    memory: { "Open the board": "Öffne das Brett" },
    ask: async (_, user) => (asked.push(user), '{"segments": {"1": "Öffne das Board"}}'),
  });
  expect(asked).toHaveLength(1);
  expect(out.memory["Open the board"]).toBe("Öffne das Board");
});

test("an image's description translated past the length limit is asked again", () => {
  const { check } = segmentsOf({ type: "doc", content: [{ type: "image", attrs: { mediaId: "m", alt: "A long description", w: 1, h: 1 } }] });
  expect(check("1", "x".repeat(301))).toBe("an image's description must be at most 300 characters");
  expect(check("1", "Eine lange Beschreibung")).toBeNull();
});

test("two tags joined into one word aren't empty", () => {
  const { check } = segmentsOf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Export", marks: [{ type: "bold" }] }, { type: "text", text: " " }, { type: "text", text: "settings", marks: [{ type: "bold" }] }] }] });
  expect(check("1", "<b1>Export</b1><b2>einstellungen</b2>")).toBeNull();
});

test("a dropped line break is asked again; text left as it was is taken the second time", async () => {
  const one: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Votes are added up." }, { type: "hardBreak" }, { type: "text", text: "Comments are kept." }] }, { type: "paragraph", content: [{ type: "text", text: "Slack, GitHub, Linear and Jira" }] }] };
  const replies = [
    '{"segments": {"1": "Stimmen werden addiert. Kommentare bleiben.", "2": "Slack, GitHub, Linear and Jira"}}',
    '{"segments": {"1": "Stimmen werden addiert.<br/>Kommentare bleiben.", "2": "Slack, GitHub, Linear and Jira"}}',
  ];
  const asked: string[] = [];
  const out = await translateDoc(one, { from: "English", to: "German", ask: async (_, user) => (asked.push(user), replies.shift()!) });
  expect(asked[1]).toContain("- 1: its tags, placeholders and line breaks don't match the source's");
  expect(out.problems).toEqual([]);
  expect(out.memory["Slack, GitHub, Linear and Jira"]).toBe("Slack, GitHub, Linear and Jira");
});

test("a name kept as it is must come out whole, and formatting doesn't split a glossary phrase", () => {
  expect(glossaryProblems("Autopilot ships it", "Autopista lo publica", [{ term: "Autopilot" }])).toEqual(['"Autopilot" must stay "Autopilot"']);
  expect(glossaryProblems("Open the <b1>billing</b1> guide", "Öffne die Anleitung", [{ term: "billing guide", translation: "Abrechnungsanleitung" }])).toEqual(['"billing guide" must be translated as "Abrechnungsanleitung"']);
});

test("line breaks are checked by the document and plain text checks themselves", () => {
  const { check } = segmentsOf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "One line here" }, { type: "hardBreak" }, { type: "text", text: "Another line" }] }] });
  expect(check("1", "Eine Zeile, noch eine")).toBe("its line breaks don't match the source's");
  expect(segmentOfText("Hi\nthere").apply("Hallo")).toEqual({ id: "1", reason: "its line breaks don't match the source's" });
});

test("entities a model writes by imitation come back as characters", () => {
  const { apply } = segmentOfText("Say hi");
  expect(apply("Sag &quot;Hallo&quot; &amp; l&#39;ami&nbsp;&#x263A;")).toBe('Sag "Hallo" & l\'ami ☺');
});

test("a provider that doesn't answer is reported, not taken for a bad translation", async () => {
  const one: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Readers vote on posts they like." }] }] };
  const out = await translateDoc(one, { from: "English", to: "German", ask: async () => Promise.reject(new Error("429 rate limited")) });
  expect(out.providerError).toBe("429 rate limited");
  expect(out.doc).toEqual(one);
});

test("at most 4 requests run at once", async () => {
  const many: Doc = { type: "doc", content: Array.from({ length: 12 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `Paragraph number ${i} has words` }] })) };
  let running = 0;
  let most = 0;
  await translateDoc(many, {
    from: "English",
    to: "German",
    batchChars: 10,
    ask: async (_, user) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      const ids = Object.keys(JSON.parse(user.split("\n\n")[0]!) as object);
      return JSON.stringify({ segments: Object.fromEntries(ids.map((id) => [id, `Absatz ${id} hat Wörter`])) });
    },
  });
  expect(most).toBe(4);
});

test("two links can't be nested, a URL keeps its closing parenthesis, an image description may have >", () => {
  const a = { type: "link", attrs: { href: "https://a.example" } };
  const b = { type: "link", attrs: { href: "https://b.example" } };
  const { check } = segmentsOf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "first", marks: [a] }, { type: "text", text: " and " }, { type: "text", text: "second", marks: [b] }] }] });
  expect(check("1", "<a1>erste <a2>zweite</a2></a1> und")).toBe("<a2> is inside another <a…> tag");
  expect(segmentOfText("See https://en.wikipedia.org/wiki/Function_(mathematics) now").segment.text).toBe("See <x1/> now");
  const image = segmentsOf({ type: "doc", content: [{ type: "image", attrs: { mediaId: "m", alt: "Settings, then Billing", w: 1, h: 1 } }] });
  expect(image.check("1", "Einstellungen > Abrechnung")).toBeNull();
  expect(image.check("1", "Einstellungen <b1>x</b1>")).toBe("an image's description can't have tags");
});

test("a provider error a retry made up for isn't reported; a line break keeps its attributes", async () => {
  const one: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Votes are added up here." }, { type: "hardBreak", attrs: { soft: true } }, { type: "text", text: "Comments are kept." }] }] };
  const replies: (() => Promise<string>)[] = [() => Promise.reject(new Error("timeout")), async () => '{"segments": {"1": "Stimmen werden addiert.<br/>Kommentare bleiben."}}'];
  const out = await translateDoc(one, { from: "English", to: "German", ask: () => replies.shift()!() });
  expect(out.providerError).toBeUndefined();
  expect(out.doc.content![0]!.content![1]).toEqual({ type: "hardBreak", attrs: { soft: true } });
});

test("a newline the model adds itself is a space, in documents and plain text", () => {
  expect(segmentOfText("Hi there").apply("Hallo\nzusammen")).toBe("Hallo zusammen");
  const { apply } = segmentsOf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi there friend" }] }] });
  expect(apply({ "1": "Hallo\n zusammen" }).doc.content![0]!.content).toEqual([{ type: "text", text: "Hallo zusammen" }]);
});

test("a moved break takes the open tags' marks, a tag around a space is empty, nested parentheses stay in the URL", () => {
  const bold = { type: "bold" };
  const { apply, check } = segmentsOf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Bold words", marks: [bold] }, { type: "hardBreak", marks: [bold] }, { type: "text", text: "plain words here" }] }] });
  expect(check("1", "<b1> </b1>Fette Wörter<br/>normale Wörter")).toBe("<b1> is empty");
  expect(apply({ "1": "<b1>Fette Wörter</b1><br/>normale Wörter" }).doc.content![0]!.content![1]).toEqual({ type: "hardBreak" });
  expect(segmentOfText("See https://example.com/Foo_(bar_(baz)) now").segment.text).toBe("See <x1/> now");
});
