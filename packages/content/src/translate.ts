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

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Back to text: our three escapes, and the other entities models write by imitation (&quot;, &#39;, &nbsp;); &amp; last. */
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const unescape = (text: string) =>
  text
    .replace(/&(lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (_, name: string) => {
      const code = name.startsWith("#") ? Number.parseInt(name.slice(name[1] === "x" || name[1] === "X" ? 2 : 1), name[1] === "x" || name[1] === "X" ? 16 : 10) : NaN;
      return Number.isNaN(code) ? ENTITIES[name.toLowerCase()]! : code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&");
/** Our tags, placeholders and line breaks: the only markup segments have (never a generic `<…>`, which a reply may fake). */
const MARKUP = /<\/?[a-z]\d{1,4}>|<x\d{1,4}\/>|<br\s?\/?>/g;
type Mark = NonNullable<JSONContent["marks"]>[number];
const key = (mark: Mark) => JSON.stringify([mark.type, mark.attrs ?? {}]);
/** Whether text has anything to translate: a letter outside tags and placeholders. */
const hasWords = (tagged: string) => /\p{L}/u.test(tagged.replace(MARKUP, "").replace(/&\w{1,8};/g, ""));

/** A segment in the document: `check` says why a translation can't go back in (null: it can), `apply` puts it there. */
type Slot = { id: string; source: string; check: (text: string) => string | null; apply: (text: string) => void };

/** A text block's inline content as tagged text, and how to read a translation of it back into inline content. */
function encodeInline(nodes: JSONContent[]): { text: string; decode: (text: string) => JSONContent[] | string } {
  const tags = new Map<number, Mark>(); // tag number → its mark
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
      out += "<br/>";
    } else if (whole) {
      const id = ++n;
      kept.set(id, node);
      out += `<x${id}/>`;
    } else {
      out += escape(node.text ?? "");
    }
  }
  close(0);

  const breaks = (value: string) => (value.match(/<br\s*\/?>/g) ?? []).length;
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
      const value = unescape(raw);
      if (!value) return;
      fill();
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
        result.push({ type: "hardBreak" });
      } else if (match[4]) {
        const id = Number(match[4]);
        if (!kept.has(id) || seenKept.has(id)) return `placeholder x${id} is unknown or repeated`;
        seenKept.add(id);
        fill();
        result.push(structuredClone(kept.get(id)!));
      } else {
        const id = Number(match[3]);
        const letter = match[2]!;
        if (match[1]) {
          const top = stack.pop();
          if (!top || top.id !== id || top.letter !== letter) return `</${letter}${id}> closes a tag that isn't the innermost open one`;
          if (!top.filled) return `<${letter}${id}> is empty`;
        } else {
          const mark = tags.get(id);
          if (!mark || TAG_LETTER[mark.type!] !== letter || seenTags.has(id)) return `<${letter}${id}> is unknown or repeated`;
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
    if (/[<>]/.test(text.replace(/<(\/?)([a-z])(\d+)>|<x(\d+)\/>|<br\s*\/?>/g, ""))) return "it has a tag that isn't in the source";
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
          /[<>]/.test(translated)
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
  const tagged = text
    .split(/(`[^`\n]+`|https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"]|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8})/)
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
        if (i % 2 === 0) return unescape(part);
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
    if (!bad && /<\/?[a-z]+\d*\/?>/i.test(translated.replace(/<x(\d+)\/>|<br\s*\/?>/g, ""))) bad = "it has a tag that isn't in the source";
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
 * Translates segments: in batches, each translation checked (`fits`: whether it can go back into its document), and
 * failed ones asked again once with the reasons. Only translations that passed every check are returned and remembered.
 */
export async function translateSegments(segments: Segment[], options: TranslateOptions, fits?: (id: string, text: string) => string | null): Promise<Translated> {
  const { ask, glossary = [], memory = {}, batchChars = 6000 } = options;
  const translations: Record<string, string> = {};
  // `firstTry`: text left as it was is asked about once; asked again, it's taken as meant (names, lists of products).
  const check = (segment: Segment, text: string | undefined, firstTry = false) => {
    if (typeof text !== "string" || text.trim() === "") return "no translation";
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
    return reply.segments;
  };
  const runs = batches(todo, batchChars);
  let providerError: string | undefined;
  const unanswered = (error: unknown): Record<string, string> => {
    providerError ??= error instanceof Error ? error.message : String(error);
    return {};
  };
  const results = await inTurn(runs, (batch) => request(batch).catch(unanswered));
  const failed = new Map<string, string>();
  for (const [i, batch] of runs.entries()) {
    for (const segment of batch) {
      const text = results[i]![segment.id];
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
      ...(await inTurn(batches(again, batchChars), (batch) => request(batch, new Map(batch.map((segment) => [segment.id, failed.get(segment.id)!]))).catch(unanswered))),
    ) as Record<string, string>;
    for (const segment of again) {
      const reason = check(segment, retried[segment.id]);
      if (reason) problems.push({ id: segment.id, reason });
      else translations[segment.id] = retried[segment.id]!;
    }
  }
  const learned = { ...memory };
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
      language: typeof parsed.language === "string" ? parsed.language : undefined,
      segments: Object.fromEntries(Object.entries(segments).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
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
export async function translateText(text: string, options: TranslateOptions): Promise<{ text: string; detected?: string; problem?: Problem; providerError?: string }> {
  const { segment, apply, check } = segmentOfText(text);
  const result = await translateSegments([segment], { ...options, batchChars: Infinity }, check);
  const translated = result.translations["1"];
  if (translated === undefined) return { text, detected: result.detected, problem: result.problems[0] ?? { id: "1", reason: "no translation" }, providerError: result.providerError };
  const out = apply(translated);
  return typeof out === "string" ? { text: out, detected: result.detected } : { text, detected: result.detected, problem: out };
}
