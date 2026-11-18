import { isAlias, isCollection, isMap, isPair, isScalar, parseDocument } from "yaml";
import type { ApiAuth, ApiDoc, ApiGroup, ApiOperation, ApiParam, ApiResponse, ApiSchema, ApiServer, ApiType, ApiWarning } from "./types";

/** The most a spec's text may be, in bytes. */
export const OPENAPI_MAX_BYTES = 5 * 1024 * 1024;

// What one schema or example (a parameter's, a body's, a response's, a type's) may spell out, and a
// whole doc: named types fan out three levels deep, so a spec within the size limit could otherwise
// ask for millions of fields. Past either, a named type is only named and anything else is "object",
// with a warning. Once the doc's is spent each one still gets a little, so a parameter after many
// large types keeps its type. Every way out of the schema walk (`toSchema`) and the example walk
// (`sample`) counts at least one value first, a schema that's only `true` included, so neither can
// go round for free.
const ROOT_NODES = 2_000;
const DOC_NODES = 200_000;
const ROOT_NODES_AFTER = 100;
/** Where reading stops: a small spec can have tens of thousands of responses that each point at one wide schema. */
const DOC_NODES_MOST = 1_000_000;
const TOO_LARGE = { error: "This spec is too large once its references are followed. Split it, or shorten its examples and descriptions." };
/** The most a doc may hold, in characters: values the spec has once (an example, a description) are in a doc wherever they're used. */
const DOC_SIZE = 50_000_000;
/** How many named types are spelled out inside each other: the first met and two levels down. */
const NAMED_LEVELS = 3;

// Every piece of a doc is bounded where it's first read, so the count of pieces (bounded above)
// bounds the doc, and nothing built from them (a warning's place, a type's words, a title) can
// grow past it however often it's used:
// - A name (a path, a parameter, schema, field, tag, scheme, status, operationId, content type,
//   format, version, a reference, a server's address or variable) over its length is refused: names are what
//   things are known by, so one cut short would be another name. No real spec has one this long.
// - Text that's copied as written (descriptions, summaries, patterns, and the strings in defaults,
//   enums and examples) is cut at its length, with a warning for the place.
// - A warning's place and a type's words are made of those, and stop at a length of their own.
// An example's or default's own keys are data: shared with the spec, never copied or built from.
// The measurement after the doc is built stays as the backstop.
const NAME_MOST = 256;
const PATH_MOST = 500;
const URL_MOST = 2_000;
/** A summary, a title, a pattern. */
const LINE_MOST = 2_000;
/** A description, or a string in a default, an enum or an example. */
const TEXT_MOST = 50_000;
const TYPE_MOST = 300;
const WHERE_MOST = 1_000;

/** The text's start, never ending on half of a pair (a database refuses one). */
function cut(text: string, most: number): string {
  if (text.length <= most) return text;
  const last = text.charCodeAt(most - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? most - 1 : most);
}

/** A name from the spec, or the error that refuses the spec for it. */
function named(value: unknown, what: string, most = NAME_MOST): string {
  const text = typeof value === "string" ? value : "";
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- an error value for `readOpenApi` to return, as TOO_LARGE is
  if (text.length > most) throw { error: `This spec has ${what} over ${most} characters long, starting "${cut(text, 40)}". Shorten it and try again.` };
  return text;
}

const MESSAGES = {
  TEXT_CUT: "A text is longer than a reference holds, so it was cut short.",
  UNKNOWN_REF: 'A reference points at nothing in the spec: a schema there shows as "object", and anything else is left out.',
  OUTSIDE_REF:
    'A reference points outside the spec\'s file, which isn\'t followed: a schema there shows as "object", and anything else is left out.',
  STATUS_GUESSED: "A response's key isn't a status code: the number it starts with was used.",
  RESPONSE_SKIPPED: "A response's key isn't a status code, or is one the operation already has, so the response was left out.",
  NO_TITLE: "An operation has no summary or operationId: its method and path are its title.",
  DUPLICATE_SLUG: "Two pages would share an address: the later one got a number.",
  DUPLICATE_OPERATION: "Two paths differ only in a parameter's name, which makes them one operation: each is kept apart by its parameters' names.",
  INVALID_PARAMETER: "A parameter has no name, or isn't in the path, query, headers or cookies, so it was left out.",
  UNKNOWN_SECURITY: "An operation names a way of signing the spec doesn't declare, so it was left out.",
  SECURITY_SKIPPED: "One of the ways an operation can be signed needs a scheme the reference doesn't show, so that way was left out.",
  UNSUPPORTED_AUTH: "A way of signing isn't one the reference shows (bearer, basic, an API key, OAuth 2 or OpenID Connect), so it was left out.",
  ADDS_TO_ITSELF: "A schema adds to a type it's inside: it shows as that type, without what it adds.",
  SCHEMA_TOO_LARGE: 'A schema is too large to spell out in full: its deepest parts show as "object".',
  CALLBACKS_SKIPPED: "An operation's callbacks were left out.",
  RELATIVE_SERVER: "A server's address is relative, and a spec doesn't say what to: it's kept as written.",
  PATH_SKIPPED: "A path doesn't start with a slash, so it and its operations were left out.",
  WEBHOOKS_SKIPPED: "The spec's webhooks were left out.",
} as const;

type Obj = Record<string, unknown>;

/** What may be said about an `allOf` reference and still leave it that reference: all of it is carried over or only words. */
const WORDS = new Set(["description", "nullable", "deprecated", "default", "title", "example", "examples", "$comment"]);
/** What `constraints` puts into words, and `type`: beside a reference they're carried over or say nothing new. */
const LIMITS = new Set(
  "type minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength pattern minItems maxItems uniqueItems minProperties maxProperties readOnly writeOnly".split(" "),
);
/** A doc holds one warning per place, up to this many: past it there's nothing a team would read. */
const WARNINGS_MOST = 10_000;
/** The most a YAML file may be once its aliases are filled in, in characters: one anchor can stand in a hundred places. */
const YAML_SIZE = 4 * OPENAPI_MAX_BYTES;
/** The most anchors and aliases a YAML file may have: filling an alias in goes back over those before it, so their number squared is the work. */
const YAML_ANCHORS = 10_000;

/** The limits a read stops at. Tests pass smaller ones, to cross them with a small file. */
export type OpenApiBounds = { values?: number; docSize?: number; yamlSize?: number; yamlAnchors?: number };
/** The keywords of a schema the reader reads, besides its fields: what's kept when `allOf` parts are folded into one. */
const KEYWORDS = [...new Set([...WORDS, ...LIMITS, "enum", "const", "examples", "format", "items", "additionalProperties", "oneOf", "anyOf"])];
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const PARAM_PLACES = new Set(["path", "query", "header", "cookie"]);

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** A value under a key the spec chose: only the object's own, so "constructor" finds nothing. */
const own = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key) ? (value as Obj)[key] : undefined;
/** An object's entries, when it is one. */
const entries = (value: unknown): [string, unknown][] => (isObj(value) ? Object.entries(value) : []);

const slugify = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-|-$/g, "");

/** "createPost", "posts_list" → "Create post", "Posts list". */
function inWords(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The first free name: `base`, else `base-2`, `base-3`… `used` holds each name taken, with the last
 * number given out after it, so thousands of pages with one title don't each count from 2.
 */
function unique(base: string, used: Map<string, number>): string {
  let n = used.get(base);
  if (n === undefined) {
    used.set(base, 1);
    return base;
  }
  let value: string;
  do value = `${base}-${++n}`;
  while (used.has(value));
  used.set(base, n);
  used.set(value, 1);
  return value;
}

/** Worked out once per object in the spec, however often it's used: a long list is slow to go through each time. */
function once<T>(work: (value: Obj) => T): (value: Obj) => T {
  const kept = new WeakMap<Obj, { result: T }>();
  return (value) => {
    const known = kept.get(value) ?? { result: work(value) };
    kept.set(value, known);
    return known.result;
  };
}

function range(min: unknown, max: unknown, one = "", many = ""): string | null {
  const unit = (n: number) => (one ? ` ${n === 1 ? one : many}` : "");
  const low = typeof min === "number" ? min : null;
  const high = typeof max === "number" ? max : null;
  if (low !== null && high !== null) return low === high ? `exactly ${low}${unit(low)}` : `${low}–${high}${unit(high)}`;
  if (low !== null) return `at least ${low}${unit(low)}`;
  if (high !== null) return `at most ${high}${unit(high)}`;
  return null;
}

/** A schema's limits in words: "3–200 characters, matches ^[a-z]+$". */
function constraints(schema: Obj): string {
  // 3.0 says `exclusiveMinimum: true` beside `minimum`; 3.1 gives the limit itself.
  const above = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : schema.exclusiveMinimum === true ? schema.minimum : null;
  const below = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : schema.exclusiveMaximum === true ? schema.maximum : null;
  return [
    range(schema.exclusiveMinimum === true ? null : schema.minimum, schema.exclusiveMaximum === true ? null : schema.maximum),
    typeof above === "number" ? `more than ${above}` : null,
    typeof below === "number" ? `less than ${below}` : null,
    typeof schema.multipleOf === "number" ? `a multiple of ${schema.multipleOf}` : null,
    range(schema.minLength, schema.maxLength, "character", "characters"),
    typeof schema.pattern === "string" ? `matches ${cut(schema.pattern, LINE_MOST)}` : null,
    range(schema.minItems, schema.maxItems, "item", "items"),
    schema.uniqueItems === true ? "no two items the same" : null,
    range(schema.minProperties, schema.maxProperties, "field", "fields"),
    schema.readOnly === true ? "read-only" : null,
    schema.writeOnly === true ? "write-only" : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** The text as data: JSON, else YAML, and then only what JSON can hold (no shared or looping aliases). */
function parse(text: string, bounds: OpenApiBounds): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch {
    // Not JSON: YAML reads it next.
  }
  try {
    // Merge keys (`<<: *base`) as the tools specs are written for read them.
    // A key written twice is read as JSON reads it, the last one counting: checking each key against
    // those before it would make a long map's time grow with its length squared.
    const document = parseDocument(text, { logLevel: "error", merge: true, uniqueKeys: false });
    if (document.errors[0]) throw document.errors[0];
    // Measured and counted on the file as written, before any alias is filled in: then they all may
    // be, however often one anchor is used (the library's own limit is a hundred uses, fewer than a
    // spec's shared response has).
    const counted = { anchors: 0, most: bounds.yamlAnchors ?? YAML_ANCHORS };
    if (yamlSize(document.contents, new Map(), new Map(), counted) > (bounds.yamlSize ?? YAML_SIZE)) {
      return { error: "This file is too large once its YAML aliases are filled in. Use fewer aliases of its largest anchors." };
    }
    const read: unknown = document.toJS({ maxAliasCount: -1 });
    const value: unknown = read === undefined ? null : JSON.parse(JSON.stringify(read));
    // An unquoted `version: 1.10` is the number 1.1 to YAML: the version is what the spec's text says.
    // From the last `info` and its last `version`, as the value is when a key is written twice.
    const under = (node: unknown, key: string): unknown =>
      isMap(node) ? node.items.findLast((pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === key)?.value : undefined;
    const version = under(under(document.contents, "info"), "version");
    if (isObj(value) && isObj(value.info) && typeof value.info.version === "number" && isScalar(version) && version.source) value.info.version = version.source;
    return { value };
  } catch (error) {
    if (!(error instanceof Error) && isObj(error) && typeof error.error === "string") return { error: error.error };
    const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "").slice(0, 200) : "";
    if (error instanceof RangeError || /call stack/i.test(reason)) return { error: "This file is nested too deeply to read." };
    return { error: `This file isn't valid JSON or YAML${reason ? `: ${reason}` : "."}` };
  }
}

/**
 * About how many characters a YAML node is once its aliases are filled in: an alias counts as what
 * its anchor holds, worked out once per anchor. Throws on an anchor that holds itself, and, as an
 * error to return, on more anchors and aliases than a file may have.
 */
function yamlSize(node: unknown, anchors: Map<string, object>, sizes: Map<object, number>, counted: { anchors: number; most: number }): number {
  if (isAlias(node) || ((isScalar(node) || isCollection(node)) && node.anchor)) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- an error value for `readOpenApi` to return, as TOO_LARGE is
    if (++counted.anchors > counted.most) throw { error: `This file has more than ${counted.most.toLocaleString("en")} YAML anchors and aliases. Use fewer of them.` };
  }
  if (isAlias(node)) {
    const target = anchors.get(node.source);
    const size = target && sizes.get(target);
    if (target && size === undefined) throw new Error("an alias holds itself");
    return size ?? 2;
  }
  if (isPair(node)) return 2 + yamlSize(node.key, anchors, sizes, counted) + yamlSize(node.value, anchors, sizes, counted);
  if (!isScalar(node) && !isCollection(node)) return 2;
  // Known by its anchor from here on, sized once it's whole: an alias to it met before then is inside it.
  if (node.anchor) anchors.set(node.anchor, node);
  let size = 2;
  // A number or the like is short; bytes (YAML 1.1's `!!binary`) come out as a number for each.
  if (isScalar(node)) size += typeof node.value === "string" ? node.value.length : ArrayBuffer.isView(node.value) ? node.value.byteLength * 16 : 30;
  else for (const item of node.items) size += yamlSize(item, anchors, sizes, counted);
  sizes.set(node, size);
  return size;
}

/**
 * Reads an OpenAPI 3 spec (JSON or YAML) into the reference's shape. Never throws: text that isn't
 * a spec is an error to show the team, and whatever in a spec can't be read is a warning in the doc.
 *
 * Statuses and fields are in the spec's order except those named by a whole number ("200"), which
 * come first, lowest first: that's the order JavaScript keeps an object's keys in.
 */
export function readOpenApi(text: string, bounds: OpenApiBounds = {}): { doc: ApiDoc } | { error: string } {
  try {
    if (typeof text !== "string") return { error: "This file has no text to read." };
    if (text.length > OPENAPI_MAX_BYTES || new TextEncoder().encode(text).length > OPENAPI_MAX_BYTES) {
      return { error: "This file is over 5 MB, the most an API reference reads." };
    }
    if (text.trim() === "") return { error: "This file is empty." };
    const parsed = parse(text.replace(/^\uFEFF/, ""), bounds);
    if ("error" in parsed) return parsed;
    const root = parsed.value;
    if (isObj(root) && root.swagger !== undefined) {
      return { error: "This is a Swagger 2 (OpenAPI 2) spec. Convert it to OpenAPI 3.0 or 3.1 and try again." };
    }
    if (!isObj(root) || root.openapi === undefined) {
      return { error: "This isn't an OpenAPI spec: it has no `openapi` version. An API reference reads OpenAPI 3.0 and 3.1, in JSON or YAML." };
    }
    // YAML's unquoted `3.0` is the number 3.
    if (!/^3(\.\d|$)/.test(String(root.openapi))) {
      return { error: `This spec says it's OpenAPI ${String(root.openapi).slice(0, 20)}. An API reference reads OpenAPI 3.0 and 3.1.` };
    }
    const doc = read(root, bounds.values ?? DOC_NODES_MOST);
    const size = bounds.docSize ?? DOC_SIZE;
    return sizeOf(doc, size) > size ? TOO_LARGE : { doc };
  } catch (error) {
    // A refusal thrown from inside the read: too large, or a name too long.
    if (isObj(error) && typeof error.error === "string") return { error: error.error };
    return { error: error instanceof RangeError ? "This spec is nested too deeply to read." : "This spec couldn't be read." };
  }
}

/** About how many characters a value is as JSON; stops counting once past `limit`. */
function sizeOf(value: unknown, limit: number): number {
  if (typeof value === "string") return value.length + 2;
  if (typeof value !== "object" || value === null) return 8;
  let size = 2;
  for (const [key, inner] of Object.entries(value)) {
    size += key.length + 4 + sizeOf(inner, limit - size);
    if (size > limit) break;
  }
  return size;
}

function read(root: Obj, most: number): ApiDoc {
  /** 3.1 and later: what's written beside a `$ref` applies with it. In 3.0 it's ignored (a description is still read). */
  const besideApplies = !/^3(\.0|$)/.test(String(root.openapi));
  /**
   * A 3.1 schema with keywords beside its `$ref`, as what it means, once per schema; null without
   * any. `own`: those keywords as the schema's own with the reference as an `allOf` part, the way
   * 3.0 has to write it, so the two are read alike. `parts`: the reference and the keywords, for
   * where it's itself a part of an `allOf`.
   */
  const apart = once((node): { own: Obj; parts: unknown[] } | null => {
    const { $ref, ...beside } = node;
    if (Object.keys(beside).length === 0) return null;
    const reference = { $ref };
    return { own: { ...beside, allOf: [reference, ...list(beside.allOf)] }, parts: [reference, beside] };
  });
  const referenceWithMore = (node: unknown) => (besideApplies && isObj(node) && typeof node.$ref === "string" ? apart(node) : null);
  const split = (node: unknown): unknown => referenceWithMore(node)?.own ?? node;
  const warnings: ApiWarning[] = [];
  const warned = new Set<string>();
  /** One warning per place and kind, however many times a named schema is gone through. */
  function warn(code: keyof typeof MESSAGES, where: string) {
    if (warned.has(`${code} ${where}`) || warnings.length >= WARNINGS_MOST) return;
    warned.add(`${code} ${where}`);
    warnings.push({ code, message: MESSAGES[code], where });
  }

  /** Text copied as the spec has it, cut at its length with a warning for the place. */
  function text(value: unknown, where: string, most = TEXT_MOST): string {
    const whole = str(value);
    if (whole.length > most) warn("TEXT_CUT", where);
    return cut(whole, most);
  }
  /** A default, an enum or an example: its strings cut like any text. Each object is gone through once, however often it's used. */
  function data(value: unknown, where: string): unknown {
    if (typeof value === "string") return text(value, where);
    const made = bound(value);
    if (made.cut) warn("TEXT_CUT", where);
    return made.value;
  }
  function bound(value: unknown): { value: unknown; cut: boolean } {
    if (typeof value === "string") return value.length > TEXT_MOST ? { value: cut(value, TEXT_MOST), cut: true } : { value, cut: false };
    if (typeof value !== "object" || value === null) return { value, cut: false };
    const known = bounded.get(value);
    if (known) return known;
    const inner = Object.entries(value).map(([key, entry]) => [key, bound(entry)] as const);
    const any = inner.some(([, entry]) => entry.cut);
    const made = { value: !any ? value : Array.isArray(value) ? inner.map(([, entry]) => entry.value) : Object.fromEntries(inner.map(([key, entry]) => [key, entry.value])), cut: any };
    bounded.set(value, made);
    return made;
  }
  const bounded = new WeakMap<object, { value: unknown; cut: boolean }>();
  /** A place under another, for a warning: no longer than a place may be, however deep. */
  const under = (where: string, piece: string | number) => (where.length > WHERE_MOST ? where : `${where} › ${piece}`);

  /** What a `$ref` points at, and the type's name when that's one of the spec's named schemas. Warns with a `where`. */
  function lookup(ref: string, where?: string): { value: unknown; name?: string } | null {
    const miss = (code: "UNKNOWN_REF" | "OUTSIDE_REF") => {
      if (where !== undefined) warn(code, where);
      return null;
    };
    // A reference is read again wherever it's used, so it's as short as an address.
    named(ref, "a reference", URL_MOST);
    if (!ref.startsWith("#")) return miss("OUTSIDE_REF");
    // A URI fragment holding a JSON Pointer: percent-decoded first, then split, then `~1` and `~0`
    // read in each part ("a%7E1b" is the key "a/b"). A stray "%" is read as written.
    let pointer = ref.slice(1);
    try {
      pointer = decodeURIComponent(pointer);
    } catch {
      // Not percent-encoding: the pointer as it is.
    }
    if (!pointer.startsWith("/")) return miss("UNKNOWN_REF");
    const keys = pointer
      .slice(1)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let value: unknown = root;
    for (const key of keys) {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return miss("UNKNOWN_REF");
      value = (value as Obj)[key];
    }
    return keys.length === 3 && keys[0] === "components" && keys[1] === "schemas" ? { value, name: named(keys[2], "a schema's name") } : { value };
  }

  /** The object a parameter, response, body or example is, through its `$ref`s. */
  function follow(node: unknown, where?: string): Obj | null {
    for (let hops = 0; isObj(node) && typeof node.$ref === "string"; hops++) {
      if (hops === 20) {
        if (where !== undefined) warn("UNKNOWN_REF", where);
        return null;
      }
      node = lookup(node.$ref, where)?.value;
    }
    return isObj(node) ? node : null;
  }

  /**
   * The schema a schema is, through its `$ref`s: in 3.1, one with keywords beside its reference is
   * the two together at every step, so it stops there, to be folded in.
   */
  function followSchema(node: unknown, where?: string): Obj | null {
    node = split(node);
    for (let hops = 0; isObj(node) && typeof node.$ref === "string"; hops++) {
      if (hops === 20) {
        if (where !== undefined) warn("UNKNOWN_REF", where);
        return null;
      }
      node = split(lookup(node.$ref, where)?.value);
    }
    return isObj(node) ? node : null;
  }

  /** A schema with its `allOf` parts folded in: their fields together and their keywords, a later part's word over an earlier one's. */
  function flatten(schema: Obj, where?: string): Obj {
    if (!Array.isArray(schema.allOf)) return schema;
    const done = flattened.get(schema);
    if (done) return done;
    const seen = new Set<Obj>();
    /** What each part was folded into, and whether by a reference: the schema itself has neither. */
    const into = new Map<Obj, Obj>();
    const referenced = new Set<Obj>();
    /** The schema and the parts written in it, not come in with a reference. */
    const written = new Set<Obj>();
    const folds = new Map<Obj, Obj[]>();
    const add = (part: Obj | null, parent: Obj | null, byReference: boolean) => {
      if (!part || seen.has(part)) return;
      seen.add(part);
      if (parent) into.set(part, parent);
      // Added to the list there is, not to a copy of it: a long `allOf`'s parts would be copied once for each.
      const beside = parent && folds.get(parent);
      if (beside) beside.push(part);
      else if (parent) folds.set(parent, [part]);
      if (byReference) referenced.add(part);
      else if (!parent || written.has(parent)) written.add(part);
      // Folding in a wide schema is work and memory like spelling it out, so it counts the same.
      docNodes += 1 + fieldsOf(part.properties).length + list(part.required).length;
      if (docNodes > most) throw TOO_LARGE;
      for (const inner of list(part.allOf)) {
        const whole = split(inner);
        add(followSchema(whole, where), part, whole === inner && isObj(inner) && typeof inner.$ref === "string");
      }
      after.push(part);
    };
    /** Each part after the parts it folds in, the schema itself last: the order they're laid down in. */
    const after: Obj[] = [];
    add(schema, null, false);
    const merged = new Map<string, unknown>();
    const properties = new Map<string, unknown>();
    const required = new Set<unknown>();
    // One rule for keywords and fields, at every level: a later part's word counts over an earlier
    // one's, and a schema's own over all it folds in. Only the keywords the reader reads, so a part
    // with thousands of other keys costs what its fields do.
    const said = new Map<string, Obj>();
    const own = new Map<string, unknown>();
    for (const part of after) {
      for (const key of KEYWORDS) {
        if (!Object.hasOwn(part, key)) continue;
        merged.set(key, part[key]);
        said.set(key, part);
        if (written.has(part)) own.set(key, part[key]);
      }
      for (const name of list(part.required)) required.add(name);
      for (const [name, property] of fieldsOf(part.properties)) properties.set(name, property);
    }
    // An example or default written in the schema is the schema's. One that came in with a
    // referenced type is that type's: it's kept only when nothing between that type and the schema
    // adds fields, at any level and in any order. Otherwise it isn't of the whole, and the example
    // is made from all the fields.
    const addsFields = new Map<Obj, boolean>();
    const adds = (part: Obj): boolean => {
      const known = addsFields.get(part) ?? (fieldsOf(part.properties).length > 0 || (folds.get(part) ?? []).some(adds));
      addsFields.set(part, known);
      return known;
    };
    for (const key of ["example", "examples", "default"]) {
      let owner = said.get(key);
      while (owner && owner !== schema && !referenced.has(owner)) owner = into.get(owner);
      // The schema's own, where it has one, over a referenced type's, wherever among the parts each is written.
      if (owner && owner !== schema && own.has(key)) {
        merged.set(key, own.get(key));
        continue;
      }
      for (let part = owner; part && part !== schema; part = into.get(part)) {
        const parent = into.get(part);
        if (parent && (fieldsOf(parent.properties).length > 0 || (folds.get(parent) ?? []).some((other) => other !== part && adds(other)))) merged.delete(key);
      }
    }
    // `example` and 3.1's `examples` are one choice: where the schema's own parts write one of them, the other isn't its own.
    if (own.has("example") !== own.has("examples")) merged.delete(own.has("example") ? "examples" : "example");
    if (properties.size > 0) merged.set("properties", Object.fromEntries(properties));
    merged.set("required", [...required]);
    const whole: Obj = Object.fromEntries(merged);
    flattened.set(schema, whole);
    return whole;
  }
  const flattened = new WeakMap<Obj, Obj>();

  /** A schema's fields, listed once however often it's used: listing a very large object's keys is slow. */
  function fieldsOf(properties: unknown): [string, unknown][] {
    if (!isObj(properties)) return [];
    const listed = fields.get(properties) ?? Object.entries(properties);
    fields.set(properties, listed);
    return listed;
  }
  const fields = new WeakMap<Obj, [string, unknown][]>();

  let rootNodes = 0;
  let docNodes = 0;
  const spend = () => {
    if (++docNodes > most) throw TOO_LARGE;
    return ++rootNodes <= (docNodes <= DOC_NODES ? ROOT_NODES : ROOT_NODES_AFTER);
  };
  /** No room even to name another field: twice what may be spelled out, so the fields after a large one are still listed. */
  /** Work that grows with a list in the spec (an `allOf`'s parts) counts as that many values, each time. */
  const charge = (count: number) => {
    rootNodes += count;
    docNodes += count;
    if (docNodes > most) throw TOO_LARGE;
  };
  const spent = () => rootNodes >= 2 * (docNodes <= DOC_NODES ? ROOT_NODES : ROOT_NODES_AFTER);

  /** The type a schema says it is, without "null", else what its keywords imply; and whether it may be null. */
  // Kept per schema, as its fields are: a long `enum`, `required` or `oneOf` is gone through once, not on every use.
  const typesOf = once(typesIn);
  // One string per schema, shared by every place it's used: a long `pattern` isn't copied for each.
  const limitsOf = once(constraints);
  const choicesOf = once(choicesIn);
  /** What a schema says, by its keys, listed once: only words; words beside an `allOf`; or those and limits, all of which are carried over. */
  const saysOf = once((schema) => {
    const keys = Object.keys(schema);
    const extra = (key: string) => key.startsWith("x-");
    return {
      words: keys.every((key) => WORDS.has(key) || extra(key)),
      beside: keys.every((key) => key === "allOf" || WORDS.has(key) || extra(key)),
      carried: keys.every((key) => key === "allOf" || WORDS.has(key) || LIMITS.has(key) || extra(key)),
    };
  });
  const firstOf = once((schema) => list(schema.enum).find((value) => value !== null));
  const requiredIn = new WeakMap<unknown[], Set<unknown>>();
  function typesIn(schema: Obj): { types: string[]; nullable: boolean } {
    // A handful of short words, as types are: what's built from them stays short.
    const said = [...new Set((Array.isArray(schema.type) ? schema.type.slice(0, 20) : [schema.type]).filter((type) => typeof type === "string" && type.length <= 32))];
    const types = said.filter((type) => type !== "null").slice(0, 8);
    const nullable = schema.nullable === true || said.includes("null") || list(schema.enum).includes(null);
    if (types.length > 0) return { types, nullable };
    if (isObj(schema.properties) || isObj(schema.additionalProperties)) return { types: ["object"], nullable };
    if (schema.items !== undefined) return { types: ["array"], nullable };
    const first = firstOf(schema) ?? own(schema, "const");
    if (["string", "number", "boolean"].includes(typeof first)) return { types: [typeof first], nullable };
    return { types: [], nullable };
  }

  /** `oneOf` and `anyOf` without their "null" choices. */
  function choicesIn(schema: Obj): { choices: unknown[]; nullable: boolean } {
    const all = [...list(schema.oneOf), ...list(schema.anyOf)];
    const choices = all.filter((choice) => !(isObj(choice) && choice.type === "null"));
    return { choices, nullable: choices.length < all.length };
  }

  /** An `allOf`'s parts, a 3.1 part with keywords beside its reference as the two of them it means. */
  const partsOf = (schema: Obj): unknown[] => list(schema.allOf).flatMap((part) => referenceWithMore(part)?.parts ?? [part]);
  /** In 3.1, the description written beside a reference to a parameter, response or scheme is the one that counts. */
  const describedBy = (entry: unknown, target: Obj): unknown =>
    besideApplies && isObj(entry) && typeof entry.$ref === "string" && typeof entry.description === "string" ? entry.description : target.description;

  /** `stack`: the references it's inside. `folding`: the schemas above it that fold others in with `allOf`. */
  type Place = { where: string; root: string; stack: Obj[]; named: number; folding: Obj[] };

  function toSchema(node: unknown, place: Place): ApiSchema {
    // Counted before anything else: a schema that's `true`, or anything else that isn't one, is a value too.
    const within = spend();
    node = split(node);
    if (!isObj(node)) return { type: "any" };
    if (typeof node.$ref === "string") {
      const found = lookup(node.$ref, place.where);
      if (!found) return { type: "object" };
      const { name } = found;
      // Only named: where it would contain itself, three named types down, or once there's too much to spell out.
      // By what it points at, not how the reference is spelled ("User%20Response").
      const target = isObj(found.value) ? found.value : null;
      if ((target && place.stack.includes(target)) || (name !== undefined && place.named >= NAMED_LEVELS) || !within) {
        return name === undefined ? { type: "object" } : { type: name, ref: name };
      }
      const inner = toSchema(found.value, {
        where: name === undefined ? place.where : `schemas › ${name}`,
        root: place.root,
        stack: target ? [...place.stack, target] : place.stack,
        named: place.named + (name === undefined ? 0 : 1),
        folding: place.folding,
      });
      const description = text(node.description, place.where) || inner.description;
      return { ...inner, ...(name === undefined ? {} : { type: name, ref: name }), ...(description ? { description } : {}) };
    }
    if (!within) {
      warn("SCHEMA_TOO_LARGE", place.root);
      return { type: "object" };
    }

    // A reference among `allOf`'s parts. With nothing said about it but words ("this type, or
    // null", as 3.0 has to say it; a description in a part of its own) it's read as that reference,
    // keeping its name. One this schema is already inside (a type's field that is the type and
    // more) is only named, as anywhere; so is a schema met again under itself. Any other is folded
    // in: a base two types share isn't either inside the other.
    const parts = partsOf(node);
    charge(parts.length);
    // (A schema that folds itself in adds nothing to itself.)
    const folded = parts.flatMap((part) => {
      if (!isObj(part) || typeof part.$ref !== "string") return [];
      const value = lookup(part.$ref)?.value;
      return value === node ? [] : [{ pointer: part.$ref, value }];
    });
    const words = folded.length === 0 ? [] : [node, ...parts].filter((part): part is Obj => isObj(part) && typeof part.$ref !== "string" && (part === node ? saysOf(part).beside : saysOf(part).words));
    const alone = folded.length === 1 && words.length === parts.length ? folded[0]?.pointer : undefined;
    const again = place.folding.includes(node);
    const inside = folded.find(({ value }) => isObj(value) && place.stack.includes(value))?.pointer;
    // Met again under itself without being a type it's inside (it holds itself through a part of a
    // part): it stops here all the same, named after nothing, since no reference of its own is what it is.
    if (again && inside === undefined) {
      warn("ADDS_TO_ITSELF", place.where);
      return { type: "object" };
    }
    const held = inside ?? alone;
    if (held !== undefined) {
      // Left out: fields and the like in a part of their own, or beside the reference.
      const kept = (part: unknown) => isObj(part) && (typeof part.$ref === "string" || saysOf(part).words);
      if (!parts.every(kept) || !saysOf(node).carried) {
        warn("ADDS_TO_ITSELF", place.where);
      }
      const name = lookup(held)?.name;
      const only = inside === undefined ? toSchema({ $ref: held }, place) : name === undefined ? { type: "object" } : { type: name, ref: name };
      // The schema's own words first, whatever else it has, then those in a part of their own.
      const said = (key: string) => [node, ...words].find((part) => Object.hasOwn(part, key))?.[key];
      const description = text(said("description"), place.where) || only.description;
      const limits = limitsOf(node);
      if (str(node.pattern).length > LINE_MOST) warn("TEXT_CUT", place.where);
      return {
        ...only,
        ...(description ? { description } : {}),
        ...(said("nullable") === true ? { nullable: true } : {}),
        ...(said("deprecated") === true ? { deprecated: true } : {}),
        ...(limits ? { constraints: limits } : {}),
        ...(said("default") === undefined ? {} : { default: data(said("default"), place.where) }),
      };
    }
    if (parts.length > 0) place = { ...place, folding: [...place.folding, node] };

    const schema = flatten(node, place.where);
    const { types, nullable } = typesOf(schema);
    const { choices, nullable: nullChoice } = choicesOf(schema);
    const out: ApiSchema = { type: "any" };
    const description = text(schema.description, place.where);
    if (description) out.description = description;
    if (nullable || nullChoice) out.nullable = true;
    if (schema.deprecated === true) out.deprecated = true;
    if (Object.hasOwn(schema, "default")) out.default = data(schema.default, place.where);
    // "This or null" is this, nullable.
    if (choices.length === 1 && types.length === 0) {
      const only = toSchema(choices[0], { ...place, where: under(place.where, "option 1") });
      return { ...only, ...out, type: only.type };
    }

    if (typeof schema.format === "string") out.format = named(schema.format, "a format");
    const limits = limitsOf(schema);
    if (limits) out.constraints = limits;
    if (str(schema.pattern).length > LINE_MOST) warn("TEXT_CUT", place.where);
    const values = Object.hasOwn(schema, "const") ? [data(schema.const, place.where)] : (data(list(schema.enum), place.where) as unknown[]);
    if (values.length > 0) out.enum = values;
    if (isObj(schema.properties)) {
      const names = list(schema.required);
      const required = requiredIn.get(names) ?? new Set(names);
      requiredIn.set(names, required);
      out.properties = [];
      for (const [name, property] of fieldsOf(schema.properties)) {
        // The fields there's no room for are left out, not listed as "object" one by one.
        if (spent()) {
          warn("SCHEMA_TOO_LARGE", place.root);
          break;
        }
        named(name, "a field's name");
        out.properties.push({ name, required: required.has(name), ...toSchema(property, { ...place, where: under(place.where, name) }) });
      }
    }
    if (schema.items !== undefined && types.includes("array")) out.items = toSchema(schema.items, { ...place, where: under(place.where, "items") });
    if (choices.length > 0) out.oneOf = choices.slice(0, ROOT_NODES).map((choice, index) => toSchema(choice, { ...place, where: under(place.where, `option ${index + 1}`) }));

    // An object that only lists its choices is one of them: it's named by them, as a `oneOf` with no type is.
    const kinds = out.oneOf && !out.properties && !isObj(schema.additionalProperties) ? types.filter((type) => type !== "object") : types;
    const names = kinds.map((type) => {
      if (type === "array" && out.items) return `array of ${out.items.type}`;
      // ponytail: a map's values are only named in its type; give ApiSchema a field for them if pages need their fields.
      if (type === "object" && !out.properties && isObj(schema.additionalProperties)) {
        return `map of ${toSchema(schema.additionalProperties, { ...place, where: under(place.where, "values") }).type}`;
      }
      return type;
    });
    if (names.length === 0 && out.oneOf) names.push(...[...new Set(out.oneOf.map((choice) => choice.type))].slice(0, 8));
    // Words made of other types' words: "array of array of …" stops at a length, with "…".
    const label = names.join(" or ");
    if (names.length > 0) out.type = label.length > TYPE_MOST ? `${cut(label, TYPE_MOST)}…` : label;
    return out;
  }

  /** A value of the schema's shape, from its own examples where it has them; undefined when there's nothing to show. */
  function sample(node: unknown, stack: Obj[], where: string): unknown {
    const within = spend();
    const target = followSchema(node);
    if (!target) return isObj(node) ? {} : undefined;
    // A field that folds in a type it's inside ("this type, or null") stops there. A base two types share doesn't.
    charge(list(target.allOf).length);
    const bases = partsOf(target).flatMap((part): Obj[] => {
      const base = followSchema(part);
      return base ? [base] : [];
    });
    if (stack.includes(target) || bases.some((base) => base !== target && stack.includes(base)) || !within) return undefined;
    const schema = flatten(target);
    for (const key of ["example", "default", "const"]) if (Object.hasOwn(schema, key)) return data(schema[key], where);
    if (Array.isArray(schema.examples) && schema.examples.length > 0) return data(schema.examples[0], where);
    const { types } = typesOf(schema);
    const type = types[0];
    const value = firstOf(schema);
    if (value !== undefined) return data(value, where);
    const inside = [...stack, target];
    if (type === undefined) {
      const { choices } = choicesOf(schema);
      return choices.length > 0 ? sample(choices[0], inside, where) : undefined;
    }
    // An object that only lists its choices is the first of them.
    if (type === "object" && fieldsOf(schema.properties).length === 0 && choicesOf(schema).choices.length > 0) return sample(choicesOf(schema).choices[0], inside, where);
    if (type === "object") {
      const made: [string, unknown][] = [];
      for (const [name, property] of fieldsOf(schema.properties)) {
        if (spent()) break;
        const field = sample(property, inside, where);
        if (field !== undefined) made.push([named(name, "a field's name"), field]);
      }
      return Object.fromEntries(made);
    }
    if (type === "array") {
      const item = sample(schema.items, inside, where);
      return item === undefined ? [] : [item];
    }
    if (type === "string") {
      const formats: Record<string, string> = {
        "date-time": "2026-01-01T00:00:00Z",
        date: "2026-01-01",
        email: "user@example.com",
        uri: "https://example.com",
        url: "https://example.com",
        uuid: "00000000-0000-0000-0000-000000000000",
      };
      return own(formats, str(schema.format)) ?? "string";
    }
    if (type === "integer" || type === "number") return typeof schema.minimum === "number" ? schema.minimum : 0;
    if (type === "boolean") return true;
    return type === "null" ? null : undefined;
  }

  /** One schema as the pages show it; `named` is how many named types it's already inside. */
  function schemaAt(node: unknown, where: string, stack: Obj[] = [], named = 0): ApiSchema {
    rootNodes = 0;
    return toSchema(node, { where, root: where, stack, named, folding: [] });
  }

  /** The spec's example for a parameter, body or response, else one made from its schema. */
  function exampleOf(holder: Obj, make: boolean, where: string): unknown {
    if (Object.hasOwn(holder, "example")) return data(holder.example, where);
    const first = follow(fieldsOf(holder.examples)[0]?.[1]);
    if (first && Object.hasOwn(first, "value")) return data(first.value, where);
    // The schema's own example as the pages' fields have it: with what's beside a 3.1 reference, and what `allOf` folds in.
    const target = followSchema(holder.schema);
    const schema = target && flatten(target);
    if (schema && Object.hasOwn(schema, "example")) return data(schema.example, where);
    // 3.1's way of writing one.
    if (schema && Array.isArray(schema.examples) && schema.examples.length > 0) return data(schema.examples[0], where);
    if (!make || holder.schema === undefined) return undefined;
    rootNodes = 0;
    return sample(holder.schema, [], where);
  }

  /** A body's or response's content in the type the pages show: JSON when it's there, else the first. */
  const contentOf = once((holder): { contentType: string; media: Obj } | null => {
    const types = entries(holder.content);
    // However it's written: "application/json; charset=utf-8", then "application/problem+json".
    const plain = types.map(([type]) => (type.split(";")[0] ?? "").trim().toLowerCase());
    const json = plain.indexOf("application/json");
    const [contentType, media] = types[json === -1 ? Math.max(0, plain.findIndex((type) => type.endsWith("+json"))) : json] ?? [];
    return contentType === undefined ? null : { contentType: named(contentType, "a content type"), media: isObj(media) ? media : {} };
  });

  // Ways of signing.
  const auth: ApiAuth[] = [];
  const schemes = own(root.components, "securitySchemes");
  for (const [key, value] of entries(schemes)) {
    const where = `securitySchemes › ${named(key, "a security scheme's name")}`;
    const scheme = follow(value, where);
    if (!scheme) continue;
    const http = str(scheme.scheme).toLowerCase();
    const kind =
      scheme.type === "http" && (http === "bearer" || http === "basic")
        ? http
        : scheme.type === "apiKey" && (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie") && str(scheme.name)
          ? scheme.in
          : scheme.type === "oauth2" || scheme.type === "openIdConnect"
            ? scheme.type
            : null;
    if (!kind) warn("UNSUPPORTED_AUTH", where);
    else auth.push({ key, kind, name: scheme.type === "apiKey" ? named(scheme.name, "a security scheme's header, query or cookie name") : "Authorization", description: text(describedBy(value, scheme), where) });
  }
  const signed = new Set(auth.map((scheme) => scheme.key));

  // Named types first: they're where a schema too deep to spell out elsewhere is read in full.
  const types: (Omit<ApiType, "slug"> & { slug?: string })[] = entries(own(root.components, "schemas")).map(([name, value]) => {
    const schema = { ...schemaAt(value, `schemas › ${named(name, "a schema's name")}`, isObj(value) ? [value] : [], 1), ref: name };
    const kind = schema.enum ? "enum" : schema.properties ? "object" : schema.oneOf ? "union" : schema.type === "object" ? "object" : "scalar";
    return { name, kind, schema };
  });

  /** Where requests go: each address as the spec has it, with what may fill its variables. Made once per list, however many operations share it. */
  function serversOf(servers: unknown, where: string): ApiServer[] {
    const made = Array.isArray(servers) ? (serversMade.get(servers) ?? serversIn(servers, where)) : [];
    if (Array.isArray(servers)) serversMade.set(servers, made);
    // Relative ("/v1"): to wherever the spec was read from, which only what read it knows.
    for (const server of made) if (!/^([a-z][a-z0-9+.-]*:|\{)/i.test(server.url)) warn("RELATIVE_SERVER", `${where} › ${server.url}`);
    return made;
  }
  const serversMade = new WeakMap<unknown[], ApiServer[]>();
  const serversIn = (servers: unknown[], where: string): ApiServer[] =>
    servers
      .filter((server): server is Obj => isObj(server) && typeof server.url === "string")
      .map((server) => {
        const variables = entries(server.variables)
          .filter((entry): entry is [string, Obj] => isObj(entry[1]))
          .map(([name, variable]) => {
            // YAML's unquoted `8443` is a number.
            const filling = (value: unknown) => named(typeof value === "number" || typeof value === "boolean" ? String(value) : value, "a server variable's value");
            const values = list(variable.enum).map(filling).filter(Boolean);
            const value = { default: filling(variable.default), ...(values.length > 0 ? { enum: values } : {}), description: text(variable.description, where) };
            return [named(name, "a server variable's name"), value] as const;
          });
        return { url: named(server.url, "a server's address", URL_MOST), description: text(server.description, where), ...(variables.length > 0 ? { variables: Object.fromEntries(variables) } : {}) };
      });

  /** A path's item: the one its `$ref` points at, with what's written beside the reference over it. Made once per path. */
  function itemOf(value: unknown, where?: string): Obj | null {
    if (!isObj(value) || typeof value.$ref !== "string") return isObj(value) ? value : null;
    const known = items.get(value);
    if (known !== undefined) return known;
    const shared = follow(value, where);
    const own = fieldsOf(value).filter(([key]) => key !== "$ref");
    // Copying the shared item's fields for this path counts, as going through them does.
    if (own.length > 0) charge(fieldsOf(shared).length);
    const item = own.length === 0 ? shared : { ...shared, ...Object.fromEntries(own) };
    if (where !== undefined) items.set(value, item);
    return item;
  }
  const items = new WeakMap<Obj, Obj | null>();

  // What an operation is known by: its method and path without its parameters' names, which aren't
  // part of what a path is. Operations that would share that each keep their names, whatever their order.
  const nameless = (kind: string, path: string) => `${kind} ${path.replace(/\{[^{}/]*\}/g, "{}")}`;
  const sharing = new Map<string, number>();
  for (const [path, value] of entries(root.paths)) {
    named(path, "a path", PATH_MOST);
    if (!path.startsWith("/")) continue;
    // A path item many paths point at is gone through for each of them: that counts.
    const methods = fieldsOf(itemOf(value));
    charge(methods.length);
    for (const [method, operation] of methods) {
      if (METHODS.has(method) && isObj(operation)) sharing.set(nameless(method.toUpperCase(), path), (sharing.get(nameless(method.toUpperCase(), path)) ?? 0) + 1);
    }
  }

  /** An operation's title and the slug it makes, once per operation: a path item many paths point at has one of each. */
  const titleOf = once((operation) => {
    const summary = cut(str(operation.summary), LINE_MOST).trim();
    const title = summary || inWords(named(operation.operationId, "an operationId"));
    return { title, slug: slugify(title), untitled: !summary && !str(operation.operationId), long: str(operation.summary).length > LINE_MOST };
  });
  const slugs = new Map<string, number>();
  const seen = new Map<string, number>();
  const operations: ApiOperation[] = [];
  for (const [path, value] of entries(root.paths)) {
    if (!path.startsWith("/")) {
      if (!path.startsWith("x-")) warn("PATH_SKIPPED", path);
      continue;
    }
    const item = itemOf(value, path);
    if (!item) continue;
    for (const [method, operation] of fieldsOf(item)) {
      if (!METHODS.has(method) || !isObj(operation)) continue;
      const kind = method.toUpperCase() as ApiOperation["kind"];
      // Its place in the spec, for warnings.
      const key = `${kind} ${path}`;
      const shared = (sharing.get(nameless(kind, path)) ?? 0) > 1;
      const id = unique(shared ? key : nameless(kind, path), seen);
      if (shared) warn("DUPLICATE_OPERATION", key);
      if (operation.callbacks !== undefined) warn("CALLBACKS_SKIPPED", key);
      // An operation's lists count too, schemas or not: a shared path item's are read for every path that points at it.
      charge(1 + list(item.parameters).length + list(operation.parameters).length + list(operation.tags).length + list(operation.servers ?? item.servers).length);

      const titled = titleOf(operation);
      const title = titled.title || key;
      if (titled.long) warn("TEXT_CUT", key);
      if (titled.untitled) warn("NO_TITLE", key);
      const proposed = titled.slug || slugify(key) || "operation";
      const slug = unique(proposed, slugs);
      if (slug !== proposed) warn("DUPLICATE_SLUG", key);

      // The path's parameters, then the operation's: one of the same name and place replaces the path's.
      const params = new Map<string, ApiParam>();
      for (const [index, entry] of [...list(item.parameters), ...list(operation.parameters)].entries()) {
        const param = follow(entry, `${key} › parameters › ${index + 1}`);
        if (!param) continue;
        const name = named(param.name, "a parameter's name");
        const place = param.in as ApiParam["in"];
        if (!name || !PARAM_PLACES.has(str(place))) {
          warn("INVALID_PARAMETER", `${key} › parameters › ${name || index + 1}`);
          continue;
        }
        const holder = param.schema === undefined ? (contentOf(param)?.media ?? {}) : param;
        const where = `${key} › parameters › ${name}`;
        const schema = schemaAt(holder.schema, where);
        if (param.deprecated === true) schema.deprecated = true;
        // The parameter's own example, else its content's; no copy of either, whatever else they hold.
        const from = (key: string) => (Object.hasOwn(param, key) ? { [key]: param[key] } : Object.hasOwn(holder, key) ? { [key]: holder[key] } : {});
        const example = exampleOf({ ...from("example"), ...from("examples"), schema: holder.schema }, false, where);
        params.set(`${place} ${name}`, {
          name,
          in: place,
          required: place === "path" || param.required === true,
          description: text(describedBy(entry, param), where),
          schema,
          ...(example === undefined ? {} : { example }),
        });
      }

      const request = operation.requestBody === undefined ? null : follow(operation.requestBody, `${key} › body`);
      const content = request && contentOf(request);
      const body = content && {
        required: request.required === true,
        contentType: content.contentType,
        schema: schemaAt(content.media.schema, `${key} › body`),
        example: exampleOf(content.media, true, `${key} › body`) ?? null,
      };

      const responses: ApiResponse[] = [];
      const statuses = new Set<string>();
      for (const [code, entry] of fieldsOf(operation.responses)) {
        charge(1);
        named(code, "a response's status");
        const exact = /^([1-5]\d\d|[1-5]XX|default)$/i.test(code);
        const status = exact ? (/^default$/i.test(code) ? "default" : code.toUpperCase()) : /^\s*([1-5]\d\d)(?!\d)/.exec(code)?.[1];
        // No two of an operation's responses share a status: "404 Not Found" beside "404" is left out.
        if (status === undefined || statuses.has(status)) {
          warn("RESPONSE_SKIPPED", `${key} › responses › ${code}`);
          continue;
        }
        statuses.add(status);
        if (!exact) warn("STATUS_GUESSED", `${key} › responses › ${code}`);
        const where = `${key} › responses › ${status}`;
        const response = follow(entry, where);
        if (!response) continue;
        const shown = contentOf(response);
        // The schema before its example: reading it is what warns about what's left out.
        const schema = shown && shown.media.schema !== undefined ? schemaAt(shown.media.schema, where) : null;
        const example = shown ? exampleOf(shown.media, true, where) : undefined;
        responses.push({
          status,
          description: text(describedBy(entry, response), where),
          contentType: shown?.contentType ?? null,
          schema,
          ...(example === undefined ? {} : { example }),
        });
      }

      // The operation's own `security` (an empty list: none), else the spec's; `{}` in it is a way
      // that needs nothing. A way that needs a scheme the reference doesn't have is left out whole:
      // without that scheme it wouldn't sign.
      const needs: string[][] = [];
      const security = list(Array.isArray(operation.security) ? operation.security : root.security);
      charge(security.length); // The spec's own list is gone through for every operation without one.
      for (const requirement of security) {
        if (!isObj(requirement)) continue;
        const names = Object.keys(requirement);
        charge(names.length);
        for (const name of names) if (own(schemes, name) === undefined) warn("UNKNOWN_SECURITY", `${key} › security › ${named(name, "a security scheme's name")}`);
        if (names.every((name) => signed.has(name))) needs.push(names);
        else if (names.every((name) => own(schemes, name) !== undefined)) warn("SECURITY_SKIPPED", `${key} › security`);
      }
      const servers = operation.servers ?? item.servers;

      const [tag = "Other", ...others] = new Set(list(operation.tags).filter((name): name is string => typeof name === "string" && named(name, "a tag").trim() !== ""));
      operations.push({
        key: id,
        slug,
        group: tag,
        ...(others.length > 0 ? { alsoIn: others } : {}),
        kind,
        path,
        title,
        description: text(operation.description, key),
        deprecated: operation.deprecated === true,
        auth: needs,
        ...(servers === undefined ? {} : { servers: serversOf(servers, `${key} › servers`) }),
        params: [...params.values()],
        body,
        responses,
      });
    }
  }
  if (root.webhooks !== undefined) warn("WEBHOOKS_SKIPPED", "webhooks");

  // Groups: the spec's tags in its order, then those only operations name, then "Other"; a tag no operation has is no group.
  const descriptions = new Map<string, string>();
  for (const tag of list(root.tags)) {
    const name = isObj(tag) ? named(tag.name, "a tag") : "";
    if (isObj(tag) && name && !descriptions.has(name)) descriptions.set(name, text(tag.description, `tags › ${name}`));
  }
  const used = new Set(operations.flatMap((operation) => [operation.group, ...(operation.alsoIn ?? [])]));
  const groups: ApiGroup[] = [...new Set([...descriptions.keys(), ...[...used].filter((name) => name !== "Other"), "Other"])]
    .filter((name) => used.has(name))
    .map((name) => ({ key: name, name, description: descriptions.get(name) ?? "" }));

  for (const type of types) {
    type.slug = unique(slugify(type.name) || "type", slugs);
    if (type.slug !== (slugify(type.name) || "type")) warn("DUPLICATE_SLUG", `schemas › ${type.name}`);
  }

  const version = own(root.info, "version");
  return {
    format: "openapi",
    title: text(own(root.info, "title"), "info › title", LINE_MOST),
    version: typeof version === "string" || typeof version === "number" ? named(String(version), "a version") : null,
    description: text(own(root.info, "description"), "info › description"),
    servers: serversOf(root.servers, "servers"),
    auth,
    groups,
    operations,
    types: types as ApiType[],
    warnings,
  };
}
