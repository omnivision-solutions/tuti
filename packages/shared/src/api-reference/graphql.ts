import {
  buildASTSchema,
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isRequiredArgument,
  isRequiredInputField,
  isSpecifiedScalarType,
  isUnionType,
  Kind,
  parse as parseSdl,
  valueFromASTUntyped,
  type DefinitionNode,
  type GraphQLArgument,
  type GraphQLInputField,
  type GraphQLSchema,
  type GraphQLType,
} from "graphql";

import type { ApiDoc, ApiOperation, ApiProperty, ApiSchema, ApiType, ApiWarning } from "./types";

/**
 * What to POST to a GraphQL endpoint (`{ query }`) for a response `readGraphql` reads. It asks only
 * for what every server answers: a schema's own description, deprecated arguments and whether an
 * input takes exactly one field (`@oneOf`) are newer than many servers, which refuse the whole query
 * over a field they don't know. A schema file has them all.
 */
export const GRAPHQL_INTROSPECTION_QUERY = getIntrospectionQuery();

const MAX_LENGTH = 5 * 1024 * 1024;
/** A named type is spelled out where it's first met and this many levels down. */
const LEVELS = 2;
/**
 * The most a doc holds, in characters of its JSON. A schema whose types point at each other grows
 * far past its own size when spelled out, so one that would hold more is spelled out fewer levels
 * down, with a warning.
 *
 * Why a doc can't be built past it, in one place:
 * 1. Every piece copied into a doc is bounded before anything is built (`unbounded`): a name by
 *    `MAX_NAME`, a type's text by its name and `MAX_WRAPS`, a description or a default by
 *    `MAX_TEXT` (cut, or left out, with a warning). So nothing copied is larger than a few
 *    thousand characters, whatever the schema.
 * 2. What's left is how many pieces are copied. That's reckoned as the doc is built (`count`, at
 *    every field, value, member, argument, operation and wrapped type where it's made), and the
 *    build is given up at twice the bound. A copy the reckoning misses is off by one bounded piece
 *    per counted piece, not by the size of the schema.
 * 3. The doc as built is measured, so none over the bound is returned.
 */
const MAX_SIZE = 5_000_000;
/** What a field is reckoned at besides its own text: about what its JSON takes. */
const FIELD_SIZE = 100;
const TOO_LARGE = Symbol("too large");
/** The longest name of a type, field, argument or enum value: GraphQL sets none, and no real schema comes near. */
const MAX_NAME = 256;
/** The most lists and non-nulls around a type. */
const MAX_WRAPS = 32;
/** The most of a description that's copied, and the longest default (as JSON) that is. */
const MAX_TEXT = 10_000;

const ROOTS = [
  { kind: "query", key: "queries", name: "Queries" },
  { kind: "mutation", key: "mutations", name: "Mutations" },
  { kind: "subscription", key: "subscriptions", name: "Subscriptions" },
] as const;

/** Values for the scalars many schemas declare, so an example reads (and sends) as one would. */
const SCALAR_EXAMPLES: Record<string, unknown> = {
  String: "string",
  ID: "1",
  Int: 1,
  Float: 1.5,
  Boolean: true,
  DateTime: "2026-01-01T00:00:00Z",
  Date: "2026-01-01",
  Time: "00:00:00Z",
  JSON: {},
  JSONObject: {},
  URL: "https://example.com",
  URI: "https://example.com",
  Email: "user@example.com",
  EmailAddress: "user@example.com",
  UUID: "00000000-0000-4000-8000-000000000000",
};

/** Reads a GraphQL schema file (SDL) or an introspection result (JSON). Never throws: text that is neither is an error. */
export function readGraphql(text: string, options: { endpoint?: string } = {}): { doc: ApiDoc } | { error: string } {
  try {
    if (typeof text !== "string" || !text.trim()) {
      return { error: "The schema is empty. Use a GraphQL schema file or an introspection result as JSON." };
    }
    if (text.length > MAX_LENGTH) return { error: "The schema is over 5 MB, the most that can be read." };
    const parsed = parse(text);
    if ("error" in parsed) return parsed;
    const refused = unbounded(parsed.schema);
    if (refused) return { error: refused };
    for (let levels = LEVELS; levels >= 0; levels--) {
      try {
        const doc = toDoc(parsed.schema, options.endpoint, levels);
        if (doc.operations.length === 0) {
          return { error: "The schema has no queries, mutations or subscriptions to show." };
        }
        if (JSON.stringify(doc).length <= MAX_SIZE) return { doc };
      } catch (error) {
        if (error !== TOO_LARGE) throw error;
      }
    }
    return { error: "The schema is too large to show: its reference would be over 5 MB. Leave out what readers don't need." };
  } catch (error) {
    // A schema is built lazily, so one that's broken deep inside (or nested too deeply) fails here.
    return { error: `The schema couldn't be read: ${message(error)}` };
  }
}

function message(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const at = (error as { locations?: { line: number; column: number }[] } | null)?.locations?.[0];
  return at ? `${text} (line ${at.line}, column ${at.column})` : text;
}

function parse(text: string): { schema: GraphQLSchema } | { error: string } {
  if (!text.trimStart().startsWith("{")) {
    try {
      const ast = parseSdl(text);
      const defined = new Set(ast.definitions.map((one) => (one.kind === Kind.OBJECT_TYPE_DEFINITION ? one.name.value : "")));
      // A federated service's file extends a Query it doesn't define: the first such extension is the definition.
      const definitions = ast.definitions.map((one): DefinitionNode => {
        if (one.kind !== Kind.OBJECT_TYPE_EXTENSION || defined.has(one.name.value)) return one;
        defined.add(one.name.value);
        return { ...one, kind: Kind.OBJECT_TYPE_DEFINITION };
      });
      // Valid enough to read is enough: schemas in the wild use directives they don't declare (federation's).
      return { schema: buildASTSchema({ ...ast, definitions }, { assumeValidSDL: true }) };
    } catch (error) {
      return { error: `This isn't a GraphQL schema file or an introspection result: ${message(error)}` };
    }
  }
  let json: unknown;
  try {
    // Without the byte-order mark some editors put first: JSON doesn't take one.
    json = JSON.parse(text.trimStart());
  } catch (error) {
    return { error: `The introspection result isn't valid JSON: ${message(error)}` };
  }
  const result = json as { data?: unknown; errors?: unknown; __schema?: unknown } | null;
  const data = (result?.data ?? result) as { __schema?: unknown } | null;
  if (!data || typeof data !== "object" || !data.__schema) {
    const refused = Array.isArray(result?.errors) ? (result.errors[0] as { message?: unknown } | null)?.message : null;
    return {
      error:
        typeof refused === "string"
          ? `The endpoint answered the introspection query with an error: ${refused}. If introspection is turned off there, use the schema file.`
          : "This JSON isn't an introspection result: it has no __schema. Use the whole response to the introspection query.",
    };
  }
  try {
    return { schema: buildClientSchema(data as Parameters<typeof buildClientSchema>[0]) };
  } catch (error) {
    return { error: `The introspection result couldn't be read: ${message(error)}` };
  }
}

/**
 * What in a schema has no bound of its own, as a sentence, or null: a name that's too long, or a
 * type inside too many lists. Looked for once, before anything is built.
 */
function unbounded(schema: GraphQLSchema): string | null {
  const name = (value: string, what: string) =>
    value.length > MAX_NAME
      ? `The ${what} "${value.slice(0, 40)}…" is ${value.length.toLocaleString("en-US")} characters long. Names of up to ${MAX_NAME} characters can be shown: shorten it.`
      : null;
  const wraps = (type: GraphQLType, where: string) => {
    let depth = 0;
    for (let inner = type; isNonNullType(inner) || isListType(inner); inner = inner.ofType) depth++;
    return depth > MAX_WRAPS
      ? `The type of ${where} is inside more than ${MAX_WRAPS} lists and non-nulls. A type that deep can't be shown: flatten it.`
      : null;
  };
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith("__")) continue;
    let refused = name(type.name, "type");
    if (refused) return refused;
    if (isEnumType(type)) {
      for (const value of type.getValues()) {
        refused = name(value.name, `value of ${type.name}`);
        if (refused) return refused;
      }
    }
    if (!isObjectType(type) && !isInterfaceType(type) && !isInputObjectType(type)) continue;
    for (const field of Object.values(type.getFields())) {
      refused = name(field.name, `field of ${type.name}`) ?? wraps(field.type, `${type.name}.${field.name}`);
      if (refused) return refused;
      for (const arg of "args" in field ? field.args : []) {
        refused =
          name(arg.name, `argument of ${type.name}.${field.name}`) ?? wraps(arg.type, `${type.name}.${field.name}'s argument ${arg.name}`);
        if (refused) return refused;
      }
    }
  }
  return null;
}

/** "createPost" and "CreatePostInput" as a page's address: "create-post", "create-post-input". */
function slugOf(name: string) {
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "page"
  );
}

function toDoc(schema: GraphQLSchema, endpoint: string | undefined, levels: number): ApiDoc {
  const warnings: ApiWarning[] = [];
  if (levels < LEVELS) {
    warnings.push({
      code: "TYPES_SHORTENED",
      message: "The schema is large, so a type's fields are spelled out fewer levels down; each type's own page has them.",
      where: "",
    });
  }
  const roots = { query: schema.getQueryType(), mutation: schema.getMutationType(), subscription: schema.getSubscriptionType() };
  const rootTypes = new Set<GraphQLType>(Object.values(roots).filter((type) => type != null));
  let size = 0;
  const count = (items: number, text = 0) => {
    size += items * FIELD_SIZE + text;
    // The reckoning runs high (up to twice what the JSON comes to), and the doc as built is measured anyway.
    if (size > 2 * MAX_SIZE) throw TOO_LARGE;
  };
  /** Counts what's about to be copied into the doc: fields or arguments. */
  const weigh = (items: readonly { name: string; description?: string | null; type?: GraphQLType }[]) => {
    let text = 0;
    for (const item of items) {
      text += 3 * item.name.length + Math.min(item.description?.length ?? 0, MAX_TEXT) + 2 * String(item.type ?? "").length;
    }
    count(items.length, text);
  };
  /** One warning for a place, however many times what's there is copied. */
  const warned = new Set<string>();
  const warnOnce = (code: string, message: string, where: string) => {
    if (warned.has(`${code} ${where}`)) return;
    warned.add(`${code} ${where}`);
    warnings.push({ code, message, where });
  };
  /** A description as it's copied: all of it, or its first `MAX_TEXT` characters with a warning. */
  const words = (text: string | null | undefined, where: string) => {
    if (!text || text.length <= MAX_TEXT) return text ?? "";
    warnOnce("DESCRIPTION_CUT", `A description over ${MAX_TEXT.toLocaleString("en-US")} characters is cut there.`, where);
    // Never half of a character written as two (an emoji): a database refuses the half left over.
    const cut = text.slice(0, MAX_TEXT);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  };
  const slugs = new Set<string>();
  /** The next number to try for a slug that's taken, so many names of one slug aren't each counted up from 2. */
  const numbers = new Map<string, number>();
  const slugFor = (name: string, where: string) => {
    const base = slugOf(name);
    let slug = base;
    let n = numbers.get(base) ?? 2;
    for (; slugs.has(slug); n++) slug = `${base}-${n}`;
    numbers.set(base, n);
    if (slug !== base) {
      warnings.push({
        code: "DUPLICATE_SLUG",
        message: "Another page already has this address, so this one got a number.",
        where,
      });
    }
    slugs.add(slug);
    return slug;
  };

  /** The defaults too long to copy: found once, so one many operations take isn't read again for each. */
  const leftOut = new Set<object>();
  /** An argument's or input field's default, counted as it's copied; one too long to copy is left out, with a warning. */
  const defaultOf = (input: GraphQLArgument | GraphQLInputField, where: string) => {
    if (!input.default || leftOut.has(input)) return undefined;
    // Made anew for each copy (the doc is the caller's to change): at most `MAX_TEXT` of it, and counted.
    const value = "value" in input.default ? input.default.value : valueFromASTUntyped(input.default.literal);
    const length = JSON.stringify(value)?.length ?? 0;
    if (length > MAX_TEXT) {
      leftOut.add(input);
      warnOnce("DEFAULT_LEFT_OUT", `A default over ${MAX_TEXT.toLocaleString("en-US")} characters isn't shown.`, where);
      return undefined;
    }
    count(0, length);
    return value;
  };

  /** A type as the pages show it; `inside` holds the named types this one is being spelled out in. */
  const schemaOf = (type: GraphQLType, inside: string[]): ApiSchema => {
    // Every list and non-null around a type is a node with the whole text of what's in it. It's
    // reckoned here, where it's made, and made from the text inside it (not written out again at
    // each level), so a type wrapped a thousand deep is given up before it's a million characters.
    if (isNonNullType(type) || isListType(type)) {
      const inner = schemaOf(type.ofType, inside);
      const wrapped = isListType(type) ? `[${inner.type}]` : `${inner.type}!`;
      count(0, wrapped.length + 20);
      return isListType(type) ? { type: wrapped, items: inner } : { ...inner, type: wrapped };
    }
    const text = type.name;
    // Named, it's its name twice (`type` and `ref`).
    count(0, 2 * text.length + 20);
    // A root type has no page: its fields are the operations.
    if (isSpecifiedScalarType(type) || rootTypes.has(type)) return { type: text };
    if (inside.length > levels || inside.includes(type.name)) return { type: text, ref: type.name };
    const within = [...inside, type.name];
    const result: ApiSchema = { type: text, ref: type.name };
    if (type.description) {
      result.description = words(type.description, type.name);
      count(0, result.description.length);
    }
    if (isEnumType(type)) {
      // Only its values' names are copied.
      count(0, type.getValues().reduce((sum, value) => sum + value.name.length + 3, 0));
      result.enum = type.getValues().map((value) => value.name);
    }
    if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) weigh(Object.values(type.getFields()));
    if (isObjectType(type) || isInterfaceType(type)) {
      result.properties = Object.values(type.getFields()).map((field) => {
        const property: ApiProperty = {
          ...schemaOf(field.type, within),
          name: field.name,
          required: isNonNullType(field.type),
        };
        // The field's own words, not its type's (which weren't copied after all).
        count(0, -(property.description?.length ?? 0));
        delete property.description;
        if (field.description) property.description = words(field.description, `${type.name} › ${field.name}`);
        if (field.deprecationReason != null) property.deprecated = true;
        return property;
      });
    }
    if (isInputObjectType(type)) {
      result.properties = Object.values(type.getFields()).map((field) => {
        const property: ApiProperty = {
          ...schemaOf(field.type, within),
          name: field.name,
          required: isRequiredInputField(field),
        };
        count(0, -(property.description?.length ?? 0));
        delete property.description;
        if (field.description) property.description = words(field.description, `${type.name} › ${field.name}`);
        if (field.deprecationReason != null) property.deprecated = true;
        const value = defaultOf(field, `${type.name} › ${field.name}`);
        if (value !== undefined) property.default = value;
        return property;
      });
    }
    if (isAbstractType(type)) {
      // Each member counts itself, named or spelled out.
      result.oneOf = schema.getPossibleTypes(type).map((member) => schemaOf(member, within));
    }
    return result;
  };

  /**
   * A value to send for an input type: an input object's required fields only. Nothing (undefined)
   * for a type inside itself, and so for an input that requires one.
   */
  const inputExample = (type: GraphQLType, inside: string[]): unknown => {
    if (isNonNullType(type)) return inputExample(type.ofType, inside);
    if (isListType(type)) {
      count(0, 2);
      const item = inputExample(type.ofType, inside);
      return item === undefined ? [] : [item];
    }
    if (!isInputObjectType(type)) return leafExample(type);
    if (inside.includes(type.name)) return undefined;
    count(1);
    const within = [...inside, type.name];
    const all = Object.values(type.getFields());
    /** The first field a value can be made for, alone. */
    const one = () => {
      for (const field of all) {
        const value = inputExample(field.type, within);
        // Looked at, if not copied: an input of many fields that can't be made is still work.
        count(1);
        if (value === undefined) continue;
        weigh([field]);
        return { [field.name]: value };
      }
      return undefined;
    };
    // `@oneOf`: it takes exactly one field.
    if (type.isOneOf) return one();
    const required = all.filter(isRequiredInputField);
    weigh(required);
    const values = required.map((field) => [field.name, inputExample(field.type, within)] as const);
    if (values.some(([, value]) => value === undefined)) return undefined;
    // With nothing required it gets its first field: an empty one is refused when it takes exactly
    // one, which an endpoint's introspection doesn't always say.
    return values.length > 0 ? Object.fromEntries(values) : (one() ?? {});
  };
  const leafExample = (type: GraphQLType) => {
    if (isEnumType(type)) {
      const value = type.getValues()[0]?.name ?? null;
      count(0, (value?.length ?? 0) + 4);
      return value;
    }
    const name = getNamedType(type).name;
    // A copy: the doc is the caller's to change.
    return Object.hasOwn(SCALAR_EXAMPLES, name) ? structuredClone(SCALAR_EXAMPLES[name]) : "string";
  };

  /**
   * What to select of a returned type, and what comes back for it: its scalars and enums and, while
   * `deeper`, the same of its object fields. Fields that need arguments, and deprecated ones, are left out.
   */
  const select = (type: GraphQLType, indent: string, deeper: boolean): { text: string; example: unknown } => {
    if (isNonNullType(type)) return select(type.ofType, indent, deeper);
    if (isListType(type)) {
      count(0, 2);
      const item = select(type.ofType, indent, deeper);
      return { text: item.text, example: [item.example] };
    }
    if (isLeafType(type)) return { text: "", example: leafExample(type) };
    const lines: string[] = [];
    const example: Record<string, unknown> = {};
    if (isAbstractType(type)) {
      lines.push("__typename");
      const member = schema.getPossibleTypes(type)[0]?.name ?? type.name;
      count(1, member.length);
      example.__typename = member;
    }
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        count(1, 3 * field.name.length);
        if (field.deprecationReason != null || field.args.some(isRequiredArgument)) continue;
        if (!deeper && !isLeafType(getNamedType(field.type))) continue;
        const inner = select(field.type, `${indent}  `, false);
        lines.push(field.name + inner.text);
        example[field.name] = inner.example;
      }
    }
    if (lines.length === 0) {
      lines.push("__typename");
      count(1, type.name.length);
      example.__typename = type.name;
    }
    return { text: ` {\n${lines.map((line) => `${indent}  ${line}\n`).join("")}${indent}}`, example };
  };

  const doc: ApiDoc = {
    format: "graphql",
    title: "",
    version: null,
    description: words(schema.description, "schema"),
    servers: endpoint ? [{ url: endpoint, description: "" }] : [],
    auth: [],
    groups: [],
    operations: [],
    types: [],
    warnings,
  };

  for (const root of ROOTS) {
    const rootType = roots[root.kind];
    if (!rootType) continue;
    const fields = Object.values(rootType.getFields());
    if (fields.length === 0) continue;
    doc.groups.push({ key: root.key, name: root.name, description: words(rootType.description, rootType.name) });
    for (const field of fields) {
      const key = `${root.kind} ${field.name}`;
      // Its name is in its key, slug, path, title and query.
      count(4, 6 * field.name.length + Math.min(field.description?.length ?? 0, MAX_TEXT));
      weigh(field.args);
      const variables: Record<string, unknown> = {};
      const params = field.args.map((arg) => {
        const paramSchema = schemaOf(arg.type, []);
        const value = defaultOf(arg, `${key} › ${arg.name}`);
        if (value !== undefined) paramSchema.default = value;
        if (arg.deprecationReason != null) paramSchema.deprecated = true;
        const example = inputExample(arg.type, []);
        // Only what the field needs is sent: a made-up cursor or filter fails, and unset ones take their
        // defaults. A non-null variable must be given, so one with a default is sent as that.
        if (isNonNullType(arg.type)) variables[arg.name] = value !== undefined ? value : example;
        return {
          name: arg.name,
          in: "argument" as const,
          required: isRequiredArgument(arg),
          description: words(arg.description, `${key} › ${arg.name}`),
          schema: paramSchema,
          example,
        };
      });
      const selection = select(field.type, "  ", true);
      const name = field.name.charAt(0).toUpperCase() + field.name.slice(1);
      const declared = field.args.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ");
      const passed = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
      const operation: ApiOperation = {
        key,
        slug: slugFor(field.name, key),
        group: root.key,
        kind: root.kind,
        path: field.name,
        title: field.name,
        description: words(field.description, key),
        deprecated: field.deprecationReason != null,
        auth: [],
        params,
        body: null,
        responses: [
          {
            status: "data",
            description: "",
            contentType: "application/json",
            schema: schemaOf(field.type, []),
            example: selection.example,
          },
        ],
        query: {
          text: `${root.kind} ${name}${declared && `(${declared})`} {\n  ${field.name}${passed && `(${passed})`}${selection.text}\n}`,
          variables,
        },
      };
      doc.operations.push(operation);
    }
  }

  const named = Object.values(schema.getTypeMap())
    .filter((type) => !type.name.startsWith("__") && !isSpecifiedScalarType(type) && !rootTypes.has(type))
    // A schema file and its introspection result list types in different orders.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const type of named) {
    const kind: ApiType["kind"] = isObjectType(type)
      ? "object"
      : isInputObjectType(type)
        ? "input"
        : isEnumType(type)
          ? "enum"
          : isUnionType(type)
            ? "union"
            : isInterfaceType(type)
              ? "interface"
              : "scalar";
    doc.types.push({ name: type.name, slug: slugFor(type.name, `type ${type.name}`), kind, schema: schemaOf(type, []) });
    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        if (field.args.length === 0) continue;
        warnings.push({
          code: "FIELD_ARGUMENTS",
          message: "A field's arguments are shown only for queries, mutations and subscriptions.",
          where: `${type.name} › ${field.name}`,
        });
      }
    }
  }
  return doc;
}
