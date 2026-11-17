import { isScalar, parseDocument } from "yaml";
import type { ApiAuth, ApiDoc, ApiGroup, ApiOperation, ApiParam, ApiResponse, ApiSchema, ApiServer, ApiType, ApiWarning } from "./types";

/** The most a spec's text may be, in bytes. */
export const OPENAPI_MAX_BYTES = 5 * 1024 * 1024;

// What one schema or example (a parameter's, a body's, a response's, a type's) may spell out, and a
// whole doc: named types fan out three levels deep, so a spec within the size limit could otherwise
// ask for millions of fields. Past either, a named type is only named and anything else is "object",
// with a warning. Once the doc's is spent each one still gets a little, so a parameter after many
// large types keeps its type.
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

const MESSAGES = {
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
const WORDS = new Set(["description", "nullable", "deprecated", "default", "title", "example"]);
const onlyWords = (schema: Obj, also?: string) => Object.keys(schema).every((key) => WORDS.has(key) || key === also || key.startsWith("x-"));
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
    typeof schema.pattern === "string" ? `matches ${schema.pattern}` : null,
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
function parse(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch {
    // Not JSON: YAML reads it next.
  }
  try {
    // Merge keys (`<<: *base`) as the tools specs are written for read them.
    const document = parseDocument(text, { logLevel: "error", merge: true });
    if (document.errors[0]) throw document.errors[0];
    const read: unknown = document.toJS();
    const value: unknown = read === undefined ? null : JSON.parse(JSON.stringify(read));
    // An unquoted `version: 1.10` is the number 1.1 to YAML: the version is what the spec's text says.
    const version: unknown = document.getIn(["info", "version"], true);
    if (isObj(value) && isObj(value.info) && typeof value.info.version === "number" && isScalar(version) && version.source) value.info.version = version.source;
    return { value };
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "").slice(0, 200) : "";
    if (error instanceof RangeError || /call stack/i.test(reason)) return { error: "This file is nested too deeply to read." };
    return { error: `This file isn't valid JSON or YAML${reason ? `: ${reason}` : "."}` };
  }
}

/**
 * Reads an OpenAPI 3 spec (JSON or YAML) into the reference's shape. Never throws: text that isn't
 * a spec is an error to show the team, and whatever in a spec can't be read is a warning in the doc.
 *
 * Statuses and fields are in the spec's order except those named by a whole number ("200"), which
 * come first, lowest first: that's the order JavaScript keeps an object's keys in.
 */
export function readOpenApi(text: string): { doc: ApiDoc } | { error: string } {
  try {
    if (typeof text !== "string") return { error: "This file has no text to read." };
    if (text.length > OPENAPI_MAX_BYTES || new TextEncoder().encode(text).length > OPENAPI_MAX_BYTES) {
      return { error: "This file is over 5 MB, the most an API reference reads." };
    }
    if (text.trim() === "") return { error: "This file is empty." };
    const parsed = parse(text.replace(/^﻿/, ""));
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
    const doc = read(root);
    return sizeOf(doc, DOC_SIZE) > DOC_SIZE ? TOO_LARGE : { doc };
  } catch (error) {
    if (error === TOO_LARGE) return TOO_LARGE;
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

function read(root: Obj): ApiDoc {
  const warnings: ApiWarning[] = [];
  const warned = new Set<string>();
  /** One warning per place and kind, however many times a named schema is gone through. */
  function warn(code: keyof typeof MESSAGES, where: string) {
    if (warned.has(`${code} ${where}`)) return;
    warned.add(`${code} ${where}`);
    warnings.push({ code, message: MESSAGES[code], where });
  }

  /** What a `$ref` points at, and the type's name when that's one of the spec's named schemas. Warns with a `where`. */
  function lookup(ref: string, where?: string): { value: unknown; name?: string } | null {
    const miss = (code: "UNKNOWN_REF" | "OUTSIDE_REF") => {
      if (where !== undefined) warn(code, where);
      return null;
    };
    if (!ref.startsWith("#")) return miss("OUTSIDE_REF");
    if (!ref.startsWith("#/")) return miss("UNKNOWN_REF");
    const keys = ref
      .slice(2)
      .split("/")
      .map((part) => {
        const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
        try {
          return decodeURIComponent(key);
        } catch {
          return key;
        }
      });
    let value: unknown = root;
    for (const key of keys) {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return miss("UNKNOWN_REF");
      value = (value as Obj)[key];
    }
    return keys.length === 3 && keys[0] === "components" && keys[1] === "schemas" ? { value, name: keys[2] } : { value };
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

  /** A schema with its `allOf` parts folded in: fields together (a later part's wins), the rest from whichever says it first. */
  function flatten(schema: Obj, where?: string): Obj {
    if (!Array.isArray(schema.allOf)) return schema;
    const done = flattened.get(schema);
    if (done) return done;
    const seen = new Set<Obj>();
    const parts: Obj[] = [];
    const add = (part: Obj | null) => {
      if (!part || seen.has(part)) return;
      seen.add(part);
      // Folding in a wide schema is work and memory like spelling it out, so it counts the same.
      docNodes += 1 + fieldsOf(part.properties).length + list(part.required).length;
      if (docNodes > DOC_NODES_MOST) throw TOO_LARGE;
      parts.push(part);
      for (const inner of list(part.allOf)) add(follow(inner, where));
    };
    add(schema);
    const merged = new Map<string, unknown>();
    const properties = new Map<string, unknown>();
    const required = new Set<unknown>();
    for (const part of parts) {
      for (const [key, value] of Object.entries(part)) {
        if (key === "properties") for (const [name, property] of entries(value)) properties.set(name, property);
        else if (key === "required") for (const name of list(value)) required.add(name);
        else if (key !== "allOf" && key !== "$ref" && !merged.has(key)) merged.set(key, value);
      }
    }
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
    if (++docNodes > DOC_NODES_MOST) throw TOO_LARGE;
    return ++rootNodes <= (docNodes <= DOC_NODES ? ROOT_NODES : ROOT_NODES_AFTER);
  };
  /** No room even to name another field: twice what may be spelled out, so the fields after a large one are still listed. */
  /** Work that grows with a list in the spec (an `allOf`'s parts) counts as that many values, each time. */
  const charge = (count: number) => {
    rootNodes += count;
    docNodes += count;
    if (docNodes > DOC_NODES_MOST) throw TOO_LARGE;
  };
  const spent = () => rootNodes >= 2 * (docNodes <= DOC_NODES ? ROOT_NODES : ROOT_NODES_AFTER);

  /** The type a schema says it is, without "null", else what its keywords imply; and whether it may be null. */
  // Kept per schema, as its fields are: a long `enum`, `required` or `oneOf` is gone through once, not on every use.
  const typesOf = once(typesIn);
  const choicesOf = once(choicesIn);
  const firstOf = once((schema) => list(schema.enum).find((value) => value !== null));
  const requiredIn = new WeakMap<unknown[], Set<unknown>>();
  function typesIn(schema: Obj): { types: string[]; nullable: boolean } {
    const said = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((type) => typeof type === "string");
    const types = said.filter((type) => type !== "null");
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

  /** `stack`: the references it's inside. `folding`: the schemas above it that fold others in with `allOf`. */
  type Place = { where: string; root: string; stack: string[]; named: number; folding: Obj[] };

  function toSchema(node: unknown, place: Place): ApiSchema {
    if (!isObj(node)) return { type: "any" };
    const within = spend();
    if (typeof node.$ref === "string") {
      const found = lookup(node.$ref, place.where);
      if (!found) return { type: "object" };
      const { name } = found;
      // Only named: where it would contain itself, three named types down, or once there's too much to spell out.
      if (place.stack.includes(node.$ref) || (name !== undefined && place.named >= NAMED_LEVELS) || !within) {
        return name === undefined ? { type: "object" } : { type: name, ref: name };
      }
      const inner = toSchema(found.value, {
        where: name === undefined ? place.where : `schemas › ${name}`,
        root: place.root,
        stack: [...place.stack, node.$ref],
        named: place.named + (name === undefined ? 0 : 1),
        folding: place.folding,
      });
      const description = str(node.description) || inner.description;
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
    const parts = list(node.allOf);
    charge(parts.length);
    // (A schema that folds itself in adds nothing to itself.)
    const folded = parts.flatMap((part) => (isObj(part) && typeof part.$ref === "string" && lookup(part.$ref)?.value !== node ? [part.$ref] : []));
    const words = [node, ...parts].filter((part): part is Obj => isObj(part) && typeof part.$ref !== "string" && onlyWords(part, part === node ? "allOf" : undefined));
    const alone = folded.length === 1 && words.length === parts.length ? folded[0] : undefined;
    const inside = folded.find((pointer) => place.stack.includes(pointer)) ?? (place.folding.includes(node) ? folded[0] : undefined);
    const held = inside ?? alone;
    if (held !== undefined) {
      if (alone === undefined) warn("ADDS_TO_ITSELF", place.where);
      const name = lookup(held)?.name;
      const only = inside === undefined ? toSchema({ $ref: held }, place) : name === undefined ? { type: "object" } : { type: name, ref: name };
      const said = (key: string) => words.find((part) => Object.hasOwn(part, key))?.[key];
      const description = str(said("description")) || only.description;
      const limits = constraints(node);
      return {
        ...only,
        ...(description ? { description } : {}),
        ...(said("nullable") === true ? { nullable: true } : {}),
        ...(said("deprecated") === true ? { deprecated: true } : {}),
        ...(limits ? { constraints: limits } : {}),
        ...(said("default") === undefined ? {} : { default: said("default") }),
      };
    }
    if (folded.length > 0) place = { ...place, folding: [...place.folding, node] };

    const schema = flatten(node, place.where);
    const { types, nullable } = typesOf(schema);
    const { choices, nullable: nullChoice } = choicesOf(schema);
    const out: ApiSchema = { type: "any" };
    const description = str(schema.description);
    if (description) out.description = description;
    if (nullable || nullChoice) out.nullable = true;
    if (schema.deprecated === true) out.deprecated = true;
    if (Object.hasOwn(schema, "default")) out.default = schema.default;
    // "This or null" is this, nullable.
    if (choices.length === 1 && types.length === 0) {
      const only = toSchema(choices[0], { ...place, where: `${place.where} › option 1` });
      return { ...only, ...out, type: only.type };
    }

    if (typeof schema.format === "string") out.format = schema.format;
    const limits = constraints(schema);
    if (limits) out.constraints = limits;
    const values = Object.hasOwn(schema, "const") ? [schema.const] : list(schema.enum);
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
        out.properties.push({ name, required: required.has(name), ...toSchema(property, { ...place, where: `${place.where} › ${name}` }) });
      }
    }
    if (schema.items !== undefined && types.includes("array")) out.items = toSchema(schema.items, { ...place, where: `${place.where} › items` });
    if (choices.length > 0) out.oneOf = choices.slice(0, ROOT_NODES).map((choice, index) => toSchema(choice, { ...place, where: `${place.where} › option ${index + 1}` }));

    const names = types.map((type) => {
      if (type === "array" && out.items) return `array of ${out.items.type}`;
      // ponytail: a map's values are only named in its type; give ApiSchema a field for them if pages need their fields.
      if (type === "object" && !out.properties && isObj(schema.additionalProperties)) {
        return `map of ${toSchema(schema.additionalProperties, { ...place, where: `${place.where} › values` }).type}`;
      }
      return type;
    });
    if (names.length === 0 && out.oneOf) names.push(...new Set(out.oneOf.map((choice) => choice.type)));
    if (names.length > 0) out.type = names.join(" or ");
    return out;
  }

  /** A value of the schema's shape, from its own examples where it has them; undefined when there's nothing to show. */
  function sample(node: unknown, stack: Obj[]): unknown {
    const target = follow(node);
    if (!target) return isObj(node) ? {} : undefined;
    // A field that folds in a type it's inside ("this type, or null") stops there. A base two types share doesn't.
    charge(list(target.allOf).length);
    const bases = list(target.allOf).flatMap((part): Obj[] => {
      const base = follow(part);
      return base ? [base] : [];
    });
    if (stack.includes(target) || bases.some((base) => base !== target && stack.includes(base)) || !spend()) return undefined;
    const schema = flatten(target);
    for (const key of ["example", "default", "const"]) if (Object.hasOwn(schema, key)) return schema[key];
    if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
    const { types } = typesOf(schema);
    const type = types[0];
    const value = firstOf(schema);
    if (value !== undefined) return value;
    const inside = [...stack, target];
    if (type === undefined) {
      const { choices } = choicesOf(schema);
      return choices.length > 0 ? sample(choices[0], inside) : undefined;
    }
    if (type === "object") {
      const made: [string, unknown][] = [];
      for (const [name, property] of fieldsOf(schema.properties)) {
        if (spent()) break;
        const field = sample(property, inside);
        if (field !== undefined) made.push([name, field]);
      }
      return Object.fromEntries(made);
    }
    if (type === "array") {
      const item = sample(schema.items, inside);
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
  function schemaAt(node: unknown, where: string, stack: string[] = [], named = 0): ApiSchema {
    rootNodes = 0;
    return toSchema(node, { where, root: where, stack, named, folding: [] });
  }

  /** The spec's example for a parameter, body or response, else one made from its schema. */
  function exampleOf(holder: Obj, make: boolean): unknown {
    if (Object.hasOwn(holder, "example")) return holder.example;
    const first = follow(fieldsOf(holder.examples)[0]?.[1]);
    if (first && Object.hasOwn(first, "value")) return first.value;
    const schema = follow(holder.schema);
    if (schema && Object.hasOwn(schema, "example")) return schema.example;
    if (!make || holder.schema === undefined) return undefined;
    rootNodes = 0;
    return sample(holder.schema, []);
  }

  /** A body's or response's content in the type the pages show: JSON when it's there, else the first. */
  const contentOf = once((holder): { contentType: string; media: Obj } | null => {
    const types = entries(holder.content);
    // However it's written: "application/json; charset=utf-8", then "application/problem+json".
    const named = types.map(([type]) => (type.split(";")[0] ?? "").trim().toLowerCase());
    const json = named.indexOf("application/json");
    const [contentType, media] = types[json === -1 ? Math.max(0, named.findIndex((type) => type.endsWith("+json"))) : json] ?? [];
    return contentType === undefined ? null : { contentType, media: isObj(media) ? media : {} };
  });

  // Ways of signing.
  const auth: ApiAuth[] = [];
  const schemes = own(root.components, "securitySchemes");
  for (const [key, value] of entries(schemes)) {
    const where = `securitySchemes › ${key}`;
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
    else auth.push({ key, kind, name: scheme.type === "apiKey" ? str(scheme.name) : "Authorization", description: str(scheme.description) });
  }
  const signed = new Set(auth.map((scheme) => scheme.key));

  // Named types first: they're where a schema too deep to spell out elsewhere is read in full.
  const types: (Omit<ApiType, "slug"> & { slug?: string })[] = entries(own(root.components, "schemas")).map(([name, value]) => {
    const schema = { ...schemaAt(value, `schemas › ${name}`, [`#/components/schemas/${name}`], 1), ref: name };
    const kind = schema.enum ? "enum" : schema.properties || schema.type === "object" ? "object" : schema.oneOf ? "union" : "scalar";
    return { name, kind, schema };
  });

  /** Where requests go: each address as the spec has it, with what may fill its variables. */
  const serversOf = (servers: unknown, where: string): ApiServer[] =>
    list(servers)
      .filter((server): server is Obj => isObj(server) && typeof server.url === "string")
      .map((server) => {
        // Relative ("/v1"): to wherever the spec was read from, which only what read it knows.
        if (!/^([a-z][a-z0-9+.-]*:|\{)/i.test(str(server.url))) warn("RELATIVE_SERVER", `${where} › ${str(server.url)}`);
        const variables = entries(server.variables)
          .filter((entry): entry is [string, Obj] => isObj(entry[1]))
          .map(([name, variable]) => {
            // YAML's unquoted `8443` is a number.
            const text = (value: unknown) => (typeof value === "number" || typeof value === "boolean" ? String(value) : str(value));
            const values = list(variable.enum).map(text).filter(Boolean);
            const value = { default: text(variable.default), ...(values.length > 0 ? { enum: values } : {}), description: str(variable.description) };
            return [name, value] as const;
          });
        return { url: str(server.url), description: str(server.description), ...(variables.length > 0 ? { variables: Object.fromEntries(variables) } : {}) };
      });

  // What an operation is known by: its method and path without its parameters' names, which aren't
  // part of what a path is. Operations that would share that each keep their names, whatever their order.
  const nameless = (kind: string, path: string) => `${kind} ${path.replace(/\{[^{}/]*\}/g, "{}")}`;
  const sharing = new Map<string, number>();
  for (const [path, value] of entries(root.paths)) {
    if (!path.startsWith("/")) continue;
    for (const [method, operation] of entries(follow(value))) {
      if (METHODS.has(method) && isObj(operation)) sharing.set(nameless(method.toUpperCase(), path), (sharing.get(nameless(method.toUpperCase(), path)) ?? 0) + 1);
    }
  }

  const slugs = new Map<string, number>();
  const seen = new Map<string, number>();
  const operations: ApiOperation[] = [];
  for (const [path, value] of entries(root.paths)) {
    if (!path.startsWith("/")) {
      if (!path.startsWith("x-")) warn("PATH_SKIPPED", path);
      continue;
    }
    const item = follow(value, path);
    if (!item) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method) || !isObj(operation)) continue;
      const kind = method.toUpperCase() as ApiOperation["kind"];
      // Its place in the spec, for warnings.
      const key = `${kind} ${path}`;
      const shared = (sharing.get(nameless(kind, path)) ?? 0) > 1;
      const id = unique(shared ? key : nameless(kind, path), seen);
      if (shared) warn("DUPLICATE_OPERATION", key);
      if (operation.callbacks !== undefined) warn("CALLBACKS_SKIPPED", key);

      const title = str(operation.summary).trim() || inWords(str(operation.operationId)) || key;
      if (!str(operation.summary).trim() && !str(operation.operationId)) warn("NO_TITLE", key);
      const slug = unique(slugify(title) || slugify(key) || "operation", slugs);
      if (slug !== (slugify(title) || slugify(key) || "operation")) warn("DUPLICATE_SLUG", key);

      // The path's parameters, then the operation's: one of the same name and place replaces the path's.
      const params = new Map<string, ApiParam>();
      for (const [index, entry] of [...list(item.parameters), ...list(operation.parameters)].entries()) {
        const param = follow(entry, `${key} › parameters › ${index + 1}`);
        if (!param) continue;
        const name = str(param.name);
        const place = param.in as ApiParam["in"];
        if (!name || !PARAM_PLACES.has(str(place))) {
          warn("INVALID_PARAMETER", `${key} › parameters › ${name || index + 1}`);
          continue;
        }
        const holder = param.schema === undefined ? (contentOf(param)?.media ?? {}) : param;
        const schema = schemaAt(holder.schema, `${key} › parameters › ${name}`);
        if (param.deprecated === true) schema.deprecated = true;
        const example = exampleOf({ ...holder, ...param, schema: holder.schema }, false);
        params.set(`${place} ${name}`, {
          name,
          in: place,
          required: place === "path" || param.required === true,
          description: str(param.description),
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
        example: exampleOf(content.media, true) ?? null,
      };

      const responses: ApiResponse[] = [];
      const statuses = new Set<string>();
      for (const [code, entry] of entries(operation.responses)) {
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
        const example = shown ? exampleOf(shown.media, true) : undefined;
        responses.push({
          status,
          description: str(response.description),
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
        for (const name of names) if (own(schemes, name) === undefined) warn("UNKNOWN_SECURITY", `${key} › security › ${name}`);
        if (names.every((name) => signed.has(name))) needs.push(names);
        else if (names.every((name) => own(schemes, name) !== undefined)) warn("SECURITY_SKIPPED", `${key} › security`);
      }
      const servers = operation.servers ?? item.servers;

      const [tag = "Other", ...others] = new Set(list(operation.tags).filter((name): name is string => typeof name === "string" && name.trim() !== ""));
      operations.push({
        key: id,
        slug,
        group: tag,
        ...(others.length > 0 ? { alsoIn: others } : {}),
        kind,
        path,
        title,
        description: str(operation.description),
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
  for (const tag of list(root.tags)) if (isObj(tag) && str(tag.name) && !descriptions.has(str(tag.name))) descriptions.set(str(tag.name), str(tag.description));
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
    title: str(own(root.info, "title")),
    version: typeof version === "string" || typeof version === "number" ? String(version) : null,
    description: str(own(root.info, "description")),
    servers: serversOf(root.servers, "servers"),
    auth,
    groups,
    operations,
    types: types as ApiType[],
    warnings,
  };
}
