import type { JSONContent } from "@tiptap/core";

import type { Doc } from "./document";
import { MAX_ALT_LENGTH } from "./profiles";

/*
 * Translating a document without letting the model touch its structure (docs/plan.md, Languages). The model only
 * ever sees text: each block of text (a paragraph, heading, step title, summary, table cell's paragraph) becomes one
 * segment, its bold, italic and links as numbered tags it may move to fit the language's word order, and anything
 * that must not change (inline code, inline nodes) as a placeholder. Blocks, lists, tables, images, code blocks and
 * every attribute stay in the original document; each segment's translation is checked (every tag and placeholder
 * exactly once, nested, none empty; glossary terms as set) and put back in place of the block's text. A segment that
 * fails keeps its source text and is reported, so a reply can never break the document.
 *
 * The same functions translate plain text (Inbox messages): URLs, email addresses and `code` become placeholders.
 */

export type Segment = { id: string; text: string };
export type GlossaryTerm = { term: string; translation?: string };
export type Problem = { id: string; reason: string };

/** Text blocks: their content is inline, and each is one segment. Code blocks are never translated. */
const TEXT_BLOCKS = new Set(["paragraph", "heading", "stepTitle", "detailsSummary"]);
/** Marks the model sees as tags, outermost first (so tags nest the same way every time). Anything else is kept whole. */
const TAG_LETTER: Record<string, string> = { link: "a", bold: "b", italic: "i", strike: "s", underline: "u" };
const MARK_ORDER = Object.keys(TAG_LETTER);

/** A newline the model wrote itself is a space: only the source's own breaks (<br/>) become line breaks. */
const flat = (text: string) => (text.includes("\n") ? text.split(/\r?\n/).map((line, i, lines) => (i === 0 ? line.trimEnd() : i === lines.length - 1 ? line.trimStart() : line.trim())).join(" ") : text);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Back to text: our three escapes, and the other entities models write by imitation (&quot;, &#39;, &nbsp;); &amp; last. */
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const unescape = (text: string) =>
  text
    .replace(/&(lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (_, name: string) => {
      const code = name.startsWith("#") ? Number.parseInt(name.slice(name[1] === "x" || name[1] === "X" ? 2 : 1), name[1] === "x" || name[1] === "X" ? 16 : 10) : NaN;
      return Number.isNaN(code) ? ENTITIES[name.toLowerCase()]! : storable(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&");
/** A code point Postgres can store as text: not NUL or another control (tab and newlines aside), not half a surrogate pair, not past the last. */
const storable = (code: number) => (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) && (code < 0xd800 || code > 0xdfff) && code <= 0x10ffff;
/**
 * A tag-shaped leftover in a reply ("<strong>") that the source doesn't have as text ("Press <Enter>" may keep <Enter>);
 * a bare < or > is text. Our own markup is taken out first.
 */
const madeUpTag = (reply: string, source: string): boolean =>
  [...reply.replace(MARKUP, "").matchAll(/<\/?[a-z][\w-]{0,30}(?:\s[^<>]{0,200})?\/?>/gi)].some((m) => !unescape(source).includes(m[0]));
/** Our tags, placeholders and line breaks: the only markup segments have (never a generic `<…>`, which a reply may fake). */
const MARKUP = /<\/?[a-z]\d{1,4}>|<x\d{1,4}\/>|<br\s?\/?>/g;
type Mark = NonNullable<JSONContent["marks"]>[number];
const key = (mark: Mark) => JSON.stringify([mark.type, mark.attrs ?? {}]);
/** Whether text has anything to translate: a letter outside tags and placeholders. */
const hasWords = (tagged: string) => /\p{L}/u.test(unescape(tagged.replace(MARKUP, "")));

/** A segment in the document: `check` says why a translation can't go back in (null: it can), `apply` puts it there. */
type Slot = { id: string; source: string; check: (text: string) => string | null; apply: (text: string) => void };

/** A text block's inline content as tagged text, and how to read a translation of it back into inline content. */
function encodeInline(nodes: JSONContent[]): { text: string; decode: (text: string) => JSONContent[] | string } {
  const tags = new Map<number, Mark>(); // tag number → its mark
  const worded = new Set<number>(); // tags with more than whitespace in the source: they must have it in a translation too
  const holdsWords = (has: boolean) => has && open.forEach((tag) => worded.add(tag.id));
  const kept = new Map<number, JSONContent>(); // placeholder number → the node, as it was
  let n = 0;
  let out = "";
  let open: { key: string; id: number; letter: string }[] = [];
  const close = (to: number) => {
    while (open.length > to) {
      const tag = open.pop()!;
      out += `</${tag.letter}${tag.id}>`;
    }
  };
  for (const node of nodes) {
    const tagged = (node.marks ?? []).filter((mark) => mark.type! in TAG_LETTER).sort((a, b) => MARK_ORDER.indexOf(a.type!) - MARK_ORDER.indexOf(b.type!));
    const wanted = tagged.map(key);
    let same = 0;
    while (same < open.length && same < wanted.length && open[same]!.key === wanted[same]) same++;
    close(same);
    for (const mark of tagged.slice(same)) {
      const id = ++n;
      tags.set(id, mark);
      open.push({ key: key(mark), id, letter: TAG_LETTER[mark.type!]! });
      out += `<${TAG_LETTER[mark.type!]}${id}>`;
    }
    const whole = node.type !== "text" || (node.marks ?? []).some((mark) => !(mark.type! in TAG_LETTER));
    if (node.type === "hardBreak") {
      holdsWords(true);
      out += "<br/>";
    } else if (whole) {
      const id = ++n;
      kept.set(id, node);
      holdsWords(true);
      out += `<x${id}/>`;
    } else {
      holdsWords(Boolean(node.text?.trim()));
      out += escape(node.text ?? "");
    }
  }
  close(0);

  const breaks = (value: string) => (value.match(/<br\s*\/?>/g) ?? []).length;
  const sourceBreaks = nodes.filter((node) => node.type === "hardBreak");
  const decode = (text: string): JSONContent[] | string => {
    if (breaks(text) !== breaks(out)) return "its line breaks don't match the source's";
    const result: JSONContent[] = [];
    const stack: { id: number; letter: string; filled: boolean }[] = [];
    const seenTags = new Set<number>();
    const seenKept = new Set<number>();
    let last = 0;
    // A tag is empty unless something comes inside it (two bold words joined may share one text node).
    const fill = () => stack.forEach((tag) => (tag.filled = true));
    const pushText = (raw: string) => {
      const value = flat(unescape(raw));
      if (!value) return;
      // Only words fill a tag: a link around a space is a link no one can see.
      if (value.trim()) fill();
      const marks = stack.map((tag) => tags.get(tag.id)!);
      const prev = result.at(-1);
      if (prev?.type === "text" && !prev.marks?.some((m) => !(m.type! in TAG_LETTER)) && JSON.stringify(prev.marks ?? []) === JSON.stringify(marks)) {
        prev.text += value;
      } else {
        result.push({ type: "text", text: value, ...(marks.length > 0 && { marks }) });
      }
    };
    for (const match of text.matchAll(/<(\/?)([a-z])(\d+)>|<x(\d+)\/>|<br\s*\/?>/g)) {
      pushText(text.slice(last, match.index));
      last = match.index + match[0].length;
      if (match[0].startsWith("<br")) {
        fill();
        // The source's own break, in order (the counts match: checked above), attributes and all.
        // Its marks are the open tags', like the text around it (the model may have moved it out of one).
        const source = sourceBreaks[result.filter((node) => node.type === "hardBreak").length];
        const marks = stack.map((tag) => tags.get(tag.id)!);
        result.push({ type: "hardBreak", ...(source?.attrs && { attrs: structuredClone(source.attrs) }), ...(marks.length > 0 && { marks }) });
      } else if (match[4]) {
        const id = Number(match[4]);
        if (!kept.has(id) || seenKept.has(id)) return `placeholder x${id} is unknown or repeated`;
        seenKept.add(id);
        // Inline code drops the tags' marks (below), so it can't be what fills them.
        if (!(kept.get(id)!.marks ?? []).some((mark) => mark.type === "code")) fill();
        // Its own marks (code) stay; bold, italic and links are the open tags', like the text around it.
        const node = structuredClone(kept.get(id)!);
        // Inline code takes no other mark (the schema's code excludes them all), so it keeps only its own.
        const own = (node.marks ?? []).filter((mark) => !(mark.type! in TAG_LETTER));
        const marks = own.some((mark) => mark.type === "code") ? own : [...stack.map((tag) => tags.get(tag.id)!), ...own];
        delete node.marks;
        result.push({ ...node, ...(marks.length > 0 && { marks }) });
      } else {
        const id = Number(match[3]);
        const letter = match[2]!;
        if (match[1]) {
          const top = stack.pop();
          if (!top || top.id !== id || top.letter !== letter) return `</${letter}${id}> closes a tag that isn't the innermost open one`;
          if (!top.filled && worded.has(id)) return `<${letter}${id}> is empty`;
        } else {
          const mark = tags.get(id);
          if (!mark || TAG_LETTER[mark.type!] !== letter || seenTags.has(id)) return `<${letter}${id}> is unknown or repeated`;
          // Two links (or two bolds) can't be one inside the other: a text has one mark of each kind.
          if (stack.some((open) => open.letter === letter)) return `<${letter}${id}> is inside another <${letter}…> tag`;
          seenTags.add(id);
          stack.push({ id, letter, filled: false });
        }
      }
    }
    pushText(text.slice(last));
    if (stack.length > 0) return `<${stack[0]!.letter}${stack[0]!.id}> is never closed`;
    const missingTag = [...tags.keys()].find((id) => !seenTags.has(id));
    if (missingTag !== undefined) return `<${TAG_LETTER[tags.get(missingTag)!.type!]}${missingTag}> is missing`;
    const missingKept = [...kept.keys()].find((id) => !seenKept.has(id));
    if (missingKept !== undefined) return `placeholder <x${missingKept}/> is missing`;
    if (madeUpTag(text, out)) return "it has a tag that isn't in the source";
    return result;
  };
  return { text: out, decode };
}

/**
 * The segments to translate in `doc`, and `apply`, which returns a copy of it with each translated segment in place
 * (a segment missing from `translations`, or failing its checks, keeps its source text and is in `problems`).
 */
export function segmentsOf(doc: Doc): {
  segments: Segment[];
  check: (id: string, text: string) => string | null;
  apply: (translations: Record<string, string>) => { doc: Doc; problems: Problem[] };
} {
  const copy = structuredClone(doc);
  const slots: Slot[] = [];
  const visit = (node: JSONContent) => {
    if (TEXT_BLOCKS.has(node.type ?? "")) {
      const { text, decode } = encodeInline(node.content ?? []);
      if (hasWords(text)) {
        const id = String(slots.length + 1);
        slots.push({
          id,
          source: text,
          check: (translated) => {
            const content = decode(translated);
            return typeof content === "string" ? content : null;
          },
          apply: (translated) => {
            node.content = decode(translated) as JSONContent[];
          },
        });
      }
      return;
    }
    if (node.type === "image" && typeof node.attrs?.alt === "string" && hasWords(escape(node.attrs.alt))) {
      const id = String(slots.length + 1);
      slots.push({
        id,
        source: escape(node.attrs.alt),
        check: (translated) =>
          translated.replace(MARKUP, "") !== translated || madeUpTag(translated, escape(String(node.attrs!.alt)))
            ? "an image's description can't have tags"
            : unescape(translated).trim().length > MAX_ALT_LENGTH
              ? `an image's description must be at most ${MAX_ALT_LENGTH} characters`
              : null,
        apply: (translated) => {
          node.attrs!.alt = unescape(translated).trim();
        },
      });
      return;
    }
    if (node.type === "codeBlock") return;
    node.content?.forEach(visit);
  };
  visit(copy);
  let applied = false;
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  return {
    segments: slots.map(({ id, source }) => ({ id, text: source })),
    check: (id, text) => byId.get(id)?.check(text) ?? null,
    apply: (translations) => {
      if (applied) throw new Error("apply runs once: segmentsOf again for another language");
      applied = true;
      const problems: Problem[] = [];
      for (const slot of slots) {
        const translated = translations[slot.id];
        const reason = translated === undefined ? "no translation" : slot.check(translated);
        if (reason) problems.push({ id: slot.id, reason });
        else slot.apply(translated!);
      }
      return { doc: copy, problems };
    },
  };
}

/** Plain text (an Inbox message) as one segment: line breaks, URLs, email addresses and `code` kept as they are. */
export function segmentOfText(text: string): { segment: Segment; apply: (translated: string) => string | Problem; check: (id: string, translated: string) => string | null } {
  const kept: string[] = [];
  const parts = text.split(/(`[^`\n]+`|https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"]|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8})/i);
  // A URL's closing parenthesis is left out unless the URL opened one (".../Function_(mathematics)"): take it back.
  for (let i = 1; i < parts.length; i += 2) {
    while (/^https?:/i.test(parts[i]!) && (parts[i]!.match(/\(/g) ?? []).length > (parts[i]!.match(/\)/g) ?? []).length && parts[i + 1]!.startsWith(")")) {
      parts[i] = `${parts[i]})`;
      parts[i + 1] = parts[i + 1]!.slice(1);
    }
  }
  const tagged = parts
    .map((part, i) => {
      if (i % 2 === 0) return escape(part).replace(/\r?\n/g, "<br/>");
      kept.push(part);
      return `<x${kept.length}/>`;
    })
    .join("");
  const apply = (translated: string): string | Problem => {
    const seen = new Set<number>();
    let bad: string | null = null;
    // Only the translated text is unescaped: what a placeholder stands for goes back exactly as it was.
    const out = translated
      .split(/(<x\d+\/>|<br\s*\/?>)/)
      .map((part, i) => {
        if (i % 2 === 0) return flat(unescape(part));
        const id = /^<x(\d+)\/>$/.exec(part)?.[1];
        if (!id) return "\n";
        const n = Number(id);
        if (!kept[n - 1] || seen.has(n)) bad = `placeholder <x${n}/> is unknown or repeated`;
        seen.add(n);
        return kept[n - 1] ?? "";
      })
      .join("");
    if (!bad && seen.size !== kept.length) bad = "a placeholder is missing";
    if (!bad && (translated.match(/<br\s*\/?>/g) ?? []).length !== (tagged.match(/<br\/>/g) ?? []).length) bad = "its line breaks don't match the source's";
    if (!bad && madeUpTag(translated, tagged)) bad = "it has a tag that isn't in the source";
    return bad ? { id: "1", reason: bad } : out;
  };
  return {
    segment: { id: "1", text: tagged },
    apply,
    check: (_, translated) => {
      const out = apply(translated);
      return typeof out === "string" ? null : out.reason;
    },
  };
}

/** Where a glossary term must come out in a translated segment: as its translation, or unchanged when it has none. */
export function glossaryProblems(source: string, translated: string, glossary: GlossaryTerm[]): string[] {
  // Formatting tags go without a trace ("<b1>billing</b1> guide" is "billing guide"); placeholders and breaks split words.
  const plain = (text: string) => unescape(text.replace(/<\/?[a-z]\d{1,4}>/g, "").replace(MARKUP, " ")).toLowerCase();
  const [from, to] = [plain(source), plain(translated)];
  return glossary
    .filter(({ term }) => uses(from, term.toLowerCase()))
    // A name kept as it is must come out whole (inflected endings allowed, "Autopilots"); only a translation may be stemmed.
    .filter(({ term, translation }) => !contains(to, translation ? stem(translation.toLowerCase()) : term.toLowerCase()))
    .map(({ term, translation }) => (translation ? `"${term}" must be translated as "${translation}"` : `"${term}" must stay "${term}"`));
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** How many times a text has been tested for a term (termsUsed: once per term; termMatcher: once per text, all its terms at once). For tests. */
export const termTests = { count: 0 };

/**
 * termsUsed for many texts against one list: the terms as one pattern, built once, so each text is read once whatever the
 * number of terms (a glossary save matching a whole help center). Where one term is part of a longer one ("Board", "Board
 * view"), a text using only the longer is said to use the longer.
 */
export function termMatcher(glossary: GlossaryTerm[]): (text: string) => GlossaryTerm[] {
  const byKey = new Map(glossary.map((entry) => [entry.term.toLowerCase(), entry]));
  const [cjk, spaced] = [[...byKey.keys()].filter((term) => CJK.test(term)), [...byKey.keys()].filter((term) => !CJK.test(term))];
  const escaped = spaced.sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = escaped.length > 0 ? new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join("|")})(?:s|es|'s|’s)?(?![\\p{L}\\p{N}])`, "gu") : null;
  return (text) => {
    termTests.count++;
    const plain = unescape(text).toLowerCase();
    const found = new Set<string>(pattern ? [...plain.matchAll(pattern)].map((match) => match[1]!) : []);
    for (const term of cjk) if (plain.includes(term)) found.add(term);
    return [...found].map((term) => byKey.get(term)!);
  };
}

/** The glossary's terms `text` uses (as glossaryProblems checks them): only those are sent with it, and a change to another doesn't touch it. */
export function termsUsed(text: string, glossary: GlossaryTerm[]): GlossaryTerm[] {
  termTests.count += glossary.length;
  const plain = unescape(text).toLowerCase();
  return glossary.filter(({ term }) => uses(plain, term.toLowerCase()));
}

/** Whether the source uses `term`: as a word, or its plural or possessive ("boards", "Tuti's"; not "Postpone" for "Post"). */
function uses(text: string, term: string): boolean {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:s|es|'s|’s)?(?![\\p{L}\\p{N}])`, "u").test(text);
}

/** Whether `text` has a word starting with `term` (so "boards", "Tuti's"), or has it anywhere for scripts without spaces. */
function contains(text: string, term: string): boolean {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, "u").test(text);
}

/**
 * A translated term as it may be inflected: a word of 6 letters or more loses its last 2 ("tablica" matches "tablicy").
 * ponytail: a crude stem, not a per-language one; it can miss a stem change (German umlauts) and accept a near word.
 */
const stem = (term: string) => (/^\p{L}{6,}$/u.test(term) ? term.slice(0, -2) : term);

export type TranslateOptions = {
  /** Language names or BCP 47 codes. `from` unset: the model says which language the text is in (Inbox). */
  from?: string;
  to: string;
  glossary?: GlossaryTerm[];
  /** The team's own instructions for this language ("Use du, not Sie"). */
  instructions?: string;
  /** What the text is (an article's title, "a customer's chat message"), for context. */
  about?: string;
  /** The model: one system and one user message in, its reply out (complete, or a fake in tests). */
  ask: (system: string, user: string) => Promise<string>;
  /** Earlier translations of segments, by their source text: reused as they are, so only changed text is sent. */
  memory?: Record<string, string>;
  /** The most source text sent in one request; more is split into several, each with its neighbours' order kept. */
  batchChars?: number;
};

/** `providerError`: why the provider didn't answer a request (an outage, a bad key, a timeout), so the caller can say so and try again. */
export type Translated = { translations: Record<string, string>; problems: Problem[]; detected?: string; memory: Record<string, string>; providerError?: string };

/** At most this many requests at once, so a long article doesn't burst the provider. */
const PARALLEL = 4;
async function inTurn<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    }),
  );
  return out;
}

export function translationPrompt({ from, to, glossary = [], instructions, about }: Omit<TranslateOptions, "ask" | "memory" | "batchChars">): string {
  return [
    `You translate ${from ? `from ${from} ` : ""}into ${to}. ${about ? `The text is ${about}.` : ""}`,
    "You get a JSON object of segments by id, in the order they appear; translate each one.",
    "Segments contain tags: <b1>…</b1> bold, <i2>…</i2> italic, <a3>…</a3> a link, <s4>…</s4> struck out, <u5>…</u5> underlined. Keep every tag exactly once with its number, around the words it belongs to; move it if the language's word order needs. Never leave a tag empty.",
    "<x6/> is a placeholder for something that is never translated (code, a link, an address): keep each one exactly once, where it belongs. <br/> is a line break: keep it. &lt; &gt; &amp; are the characters < > &: keep them escaped.",
    "Keep product names, code, commands, file names and keyboard keys as they are. Write naturally, like documentation written in the language, not a word-for-word translation; keep the meaning and the tone (formal or informal) of the source.",
    glossary.length > 0
      ? `Glossary, always followed:\n${glossary.map(({ term, translation }) => (translation ? `- "${term}" → "${translation}"` : `- "${term}": never translated`)).join("\n")}`
      : "",
    instructions ? `The team's instructions for this language:\n${instructions}` : "",
    `Reply with JSON only: {${from ? "" : '"language": "<the BCP 47 code of the source language, e.g. de or pt-BR>", '}"segments": {"<id>": "<translation>", …}} with every id.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A reply's tag-shaped text the source has only as text ("&lt;h1&gt;", "&lt;br&gt;") escaped back, so a model that
 * forgot to escape it isn't taken for changing the markup.
 */
function asText(segment: Segment, reply: string | undefined): string | undefined {
  // Compared as the source has it, whatever the case or spacing ("<H1>", "<br />" for "&lt;h1&gt;", "&lt;br/&gt;").
  const norm = (tag: string) => tag.toLowerCase().replace(/\s/g, "");
  const asTextInSource = new Set([...segment.text.matchAll(/&lt;\/?[a-z][\w-]{0,30}\s?\/?&gt;/gi)].map((m) => norm(unescape(m[0]))));
  // A tag shaped like the source's own markup ("<br/>" for a real break) is markup, whatever the text also has.
  const markupInSource = new Set([...segment.text.matchAll(MARKUP)].map((m) => norm(m[0])));
  return reply?.replace(/<\/?[a-z][\w-]{0,30}\s?\/?>/gi, (tag) => (!markupInSource.has(norm(tag)) && asTextInSource.has(norm(tag)) ? escape(tag) : tag));
}

/**
 * Translates segments: in batches, each translation checked (`fits`: whether it can go back into its document), and
 * failed ones asked again once with the reasons. Only translations that passed every check are returned and remembered.
 */
export async function translateSegments(segments: Segment[], options: TranslateOptions, fits?: (id: string, text: string) => string | null): Promise<Translated> {
  const { ask, glossary = [], memory = {}, batchChars = 6000 } = options;
  const translations: Record<string, string> = {};
  // `firstTry`: text left as it was is asked about once; asked again, it's taken as meant (names, lists of products).
  const check = (segment: Segment, text: string | undefined, firstTry = false) => {
    // A reply with no words (blank, or only entities like &nbsp;) isn't a translation of text that had some.
    if (typeof text !== "string" || text.trim() === "" || (hasWords(segment.text) && !hasWords(text))) return "no translation";
    const tagged = (value: string) => [...value.matchAll(/<\/?[a-z]\d+>|<x\d+\/>|<br\s*\/?>/g)].map((m) => (m[0].startsWith("<br") ? "<br/>" : m[0])).sort().join();
    if (tagged(segment.text) !== tagged(text)) return "its tags, placeholders and line breaks don't match the source's";
    const misfit = fits?.(segment.id, text);
    if (misfit) return misfit;
    // Left in the source language: only when the source's is known (a message may already be in the target's).
    if (firstTry && options.from && text.trim() === segment.text.trim() && (segment.text.match(/\p{L}{2,}/gu) ?? []).length >= 4) return "it isn't translated";
    return glossaryProblems(segment.text, text, glossary).join("; ") || null;
  };
  // A remembered translation is reused only while it still passes the checks (a glossary term added since, say).
  const todo = segments.filter((segment) => {
    const known = memory[segment.text];
    if (known !== undefined && !check(segment, known)) translations[segment.id] = known;
    return translations[segment.id] === undefined;
  });
  let detected: string | undefined;
  const system = translationPrompt(options);
  const request = async (batch: Segment[], notes?: Map<string, string>) => {
    const user = JSON.stringify(Object.fromEntries(batch.map(({ id, text }) => [id, text])));
    const extra = notes ? `\n\nYour last translations of these broke a rule; fix them:\n${[...notes].map(([id, why]) => `- ${id}: ${why}`).join("\n")}` : "";
    const reply = parseReply(await ask(system, user + extra));
    detected ??= reply.language;
    // Only the ids this request asked for: an extra one can't overwrite another batch's translation.
    return Object.fromEntries(batch.filter((segment) => Object.hasOwn(reply.segments, segment.id)).map((segment) => [segment.id, reply.segments[segment.id]!]));
  };
  const runs = batches(todo, batchChars);
  // Why each segment's latest request went unanswered (its retry's, once retried): only those count as the provider's fault.
  const unansweredWhy = new Map<string, string>();
  const send = (batch: Segment[], notes?: Map<string, string>) => {
    for (const segment of batch) unansweredWhy.delete(segment.id);
    return request(batch, notes).catch((error: unknown) => {
      for (const segment of batch) unansweredWhy.set(segment.id, error instanceof Error ? error.message : String(error));
      return {} as Record<string, string>;
    });
  };
  const results = await inTurn(runs, (batch) => send(batch));
  const failed = new Map<string, string>();
  for (const [i, batch] of runs.entries()) {
    for (const segment of batch) {
      const text = asText(segment, results[i]![segment.id]);
      const reason = check(segment, text, true);
      if (reason) failed.set(segment.id, reason);
      else translations[segment.id] = text!;
    }
  }
  const problems: Problem[] = [];
  if (failed.size > 0) {
    const again = todo.filter((segment) => failed.has(segment.id));
    const retried = Object.assign(
      {},
      ...(await inTurn(batches(again, batchChars), (batch) => send(batch, new Map(batch.map((segment) => [segment.id, failed.get(segment.id)!]))))),
    ) as Record<string, string>;
    for (const segment of again) {
      retried[segment.id] = asText(segment, retried[segment.id])!;
      // Unchanged text is taken as meant only when the model kept it twice, not after a reply that failed otherwise.
      const reason = check(segment, retried[segment.id], failed.get(segment.id) !== "it isn't translated");
      if (reason) problems.push({ id: segment.id, reason });
      else translations[segment.id] = retried[segment.id]!;
    }
  }
  const providerError = segments.map((segment) => (translations[segment.id] === undefined ? unansweredWhy.get(segment.id) : undefined)).find(Boolean);
  // Only the current segments: a paragraph edited or removed since drops out, so the memory doesn't grow forever.
  const learned: Record<string, string> = {};
  for (const segment of segments) {
    if (translations[segment.id] !== undefined) learned[segment.text] = translations[segment.id]!;
  }
  return { translations, problems, detected, memory: learned, providerError };
}

/** Segments in order, cut into runs of at most `max` characters (a longer segment goes alone). */
function batches(segments: Segment[], max: number): Segment[][] {
  const out: Segment[][] = [];
  let size = 0;
  for (const segment of segments) {
    if (out.length === 0 || size + segment.text.length > max) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(segment);
    size += segment.text.length;
  }
  return out;
}

/** The model's JSON reply (inside a code fence or not); anything else counts as no translations. */
function parseReply(reply: string): { language?: string; segments: Record<string, string> } {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(json) as { language?: unknown; segments?: unknown };
    const segments = parsed.segments && typeof parsed.segments === "object" ? (parsed.segments as Record<string, unknown>) : {};
    return {
      // Only something shaped like a language code: the model's word can't become a label or a stored value otherwise.
      language: typeof parsed.language === "string" && /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/i.test(parsed.language) ? parsed.language : undefined,
      // Characters Postgres can't store (a NUL or half a surrogate pair, from the JSON's escapes) never get in.
      segments: Object.fromEntries(
        Object.entries(segments)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([id, text]) => [id, Array.from(text).filter((character) => storable(character.codePointAt(0)!)).join("")]),
      ),
    };
  } catch {
    return { segments: {} };
  }
}

/** A document in another language: the same blocks, marks and attributes, its text translated. */
export async function translateDoc(doc: Doc, options: TranslateOptions): Promise<{ doc: Doc; problems: Problem[]; memory: Record<string, string>; providerError?: string }> {
  const { segments, check, apply } = segmentsOf(doc);
  const result = await translateSegments(segments, options, check);
  const applied = apply(result.translations);
  const problems = [...result.problems, ...applied.problems.filter((p) => !result.problems.some((q) => q.id === p.id))];
  return { doc: applied.doc, problems, memory: result.memory, providerError: result.providerError };
}

/** Plain text (an Inbox message) in another language, and the language it was in when `from` isn't given. */
/** Whether a message has words to translate: not one only of links, code, numbers or emoji (translateText leaves those as they are). */
export const hasTextToTranslate = (text: string) => hasWords(segmentOfText(text).segment.text);

export async function translateText(text: string, options: TranslateOptions): Promise<{ text: string; detected?: string; problem?: Problem; providerError?: string }> {
  const { segment, apply, check } = segmentOfText(text);
  // Nothing to translate (a link, code, numbers, emoji): the message is already readable as it is.
  if (!hasWords(segment.text)) return { text };
  const result = await translateSegments([segment], { ...options, batchChars: Infinity }, check);
  const translated = result.translations["1"];
  if (translated === undefined) return { text, detected: result.detected, problem: result.problems[0] ?? { id: "1", reason: "no translation" }, providerError: result.providerError };
  const out = apply(translated);
  return typeof out === "string" ? { text: out, detected: result.detected } : { text, detected: result.detected, problem: out };
}
