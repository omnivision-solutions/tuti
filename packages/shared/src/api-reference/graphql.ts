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
  type GraphQLNamedType,
  type GraphQLSchema,
  type GraphQLType,
} from "graphql";

import type { ApiDoc, ApiOperation, ApiProperty, ApiSchema, ApiType, ApiWarning } from "./types";

/**
 * What to POST to a GraphQL endpoint (`{ query }`) for a response `readGraphql` reads. It asks only
 * for what every server answers: a schema's own description and deprecated arguments are newer than
 * many servers, which refuse the whole query over a field they don't know.
 */
export const GRAPHQL_INTROSPECTION_QUERY = getIntrospectionQuery();

const MAX_LENGTH = 5 * 1024 * 1024;
/** A named type is spelled out where it's first met and this many levels down. */
const LEVELS = 2;
/**
 * The most fields a doc holds, counting each wherever it's spelled out or selected: a few megabytes
 * of JSON. A schema whose types point at each other grows far past its own size when spelled out, so
 * one that would hold more is spelled out fewer levels down, with a warning.
 */
const MAX_FIELDS = 50_000;
const TOO_LARGE = Symbol("too large");

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
    for (let levels = LEVELS; levels >= 0; levels--) {
      try {
        const doc = toDoc(parsed.schema, options.endpoint, levels);
        if (doc.operations.length === 0) {
          return { error: "The schema has no queries, mutations or subscriptions to show." };
        }
        return { doc };
      } catch (error) {
        if (error !== TOO_LARGE) throw error;
      }
    }
    return { error: "The schema is too large to show: its queries and types have too many fields between them." };
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
    json = JSON.parse(text);
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
  let fields = 0;
  const count = (more: number) => {
    fields += more;
    if (fields > MAX_FIELDS) throw TOO_LARGE;
  };
  const slugs = new Set<string>();
  const slugFor = (name: string, where: string) => {
    const base = slugOf(name);
    let slug = base;
    for (let n = 2; slugs.has(slug); n++) slug = `${base}-${n}`;
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

  const defaultOf = (input: GraphQLArgument | GraphQLInputField) =>
    input.default && ("value" in input.default ? input.default.value : valueFromASTUntyped(input.default.literal));

  /** A type as the pages show it; `inside` holds the named types this one is being spelled out in. */
  const schemaOf = (type: GraphQLType, inside: string[]): ApiSchema => {
    const text = String(type);
    if (isNonNullType(type)) return { ...schemaOf(type.ofType, inside), type: text };
    if (isListType(type)) return { type: text, items: schemaOf(type.ofType, inside) };
    if (isSpecifiedScalarType(type)) return { type: text };
    if (inside.length > levels || inside.includes(type.name)) return { type: text, ref: type.name };
    const within = [...inside, type.name];
    const result: ApiSchema = { type: text, ref: type.name };
    if (type.description) result.description = type.description;
    if (isEnumType(type)) result.enum = type.getValues().map((value) => value.name);
    if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) count(Object.keys(type.getFields()).length);
    if (isObjectType(type) || isInterfaceType(type)) {
      result.properties = Object.values(type.getFields()).map((field) => {
        const property: ApiProperty = {
          ...schemaOf(field.type, within),
          name: field.name,
          required: isNonNullType(field.type),
        };
        // The field's own words, not its type's.
        delete property.description;
        if (field.description) property.description = field.description;
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
        delete property.description;
        if (field.description) property.description = field.description;
        if (field.deprecationReason != null) property.deprecated = true;
        const value = defaultOf(field);
        if (value !== undefined) property.default = value;
        return property;
      });
    }
    if (isAbstractType(type)) result.oneOf = schema.getPossibleTypes(type).map((member) => schemaOf(member, within));
    return result;
  };

  /**
   * A value to send for an input type: an input object's required fields only (a `@oneOf` one's
   * first field: it takes exactly one). Nothing (undefined) for a type inside itself.
   */
  const inputExample = (type: GraphQLType, inside: string[]): unknown => {
    if (isNonNullType(type)) return inputExample(type.ofType, inside);
    if (isListType(type)) {
      const item = inputExample(type.ofType, inside);
      return item === undefined ? [] : [item];
    }
    if (isInputObjectType(type)) {
      if (inside.includes(type.name)) return undefined;
      const all = Object.values(type.getFields());
      const sent = type.isOneOf ? all.slice(0, 1) : all.filter(isRequiredInputField);
      count(sent.length);
      return Object.fromEntries(sent.map((field) => [field.name, inputExample(field.type, [...inside, type.name])]));
    }
    return leafExample(type);
  };
  const leafExample = (type: GraphQLType) => {
    if (isEnumType(type)) return type.getValues()[0]?.name ?? null;
    const name = getNamedType(type).name;
    return name in SCALAR_EXAMPLES ? SCALAR_EXAMPLES[name] : "string";
  };

  /**
   * What to select of a returned type, and what comes back for it: its scalars and enums and, while
   * `deeper`, the same of its object fields. Fields that need arguments, and deprecated ones, are left out.
   */
  const select = (type: GraphQLType, indent: string, deeper: boolean): { text: string; example: unknown } => {
    if (isNonNullType(type)) return select(type.ofType, indent, deeper);
    if (isListType(type)) {
      const item = select(type.ofType, indent, deeper);
      return { text: item.text, example: [item.example] };
    }
    if (isLeafType(type)) return { text: "", example: leafExample(type) };
    const lines: string[] = [];
    const example: Record<string, unknown> = {};
    if (isAbstractType(type)) {
      lines.push("__typename");
      example.__typename = schema.getPossibleTypes(type)[0]?.name ?? type.name;
    }
    if (isObjectType(type) || isInterfaceType(type)) {
      count(Object.keys(type.getFields()).length);
      for (const field of Object.values(type.getFields())) {
        if (field.deprecationReason != null || field.args.some(isRequiredArgument)) continue;
        if (!deeper && !isLeafType(getNamedType(field.type))) continue;
        const inner = select(field.type, `${indent}  `, false);
        lines.push(field.name + inner.text);
        example[field.name] = inner.example;
      }
    }
    if (lines.length === 0) {
      lines.push("__typename");
      example.__typename = type.name;
    }
    return { text: ` {\n${lines.map((line) => `${indent}  ${line}\n`).join("")}${indent}}`, example };
  };

  const doc: ApiDoc = {
    format: "graphql",
    title: "",
    version: null,
    description: schema.description ?? "",
    servers: endpoint ? [{ url: endpoint, description: "" }] : [],
    auth: [],
    groups: [],
    operations: [],
    types: [],
    warnings,
  };

  const rootTypes = new Set<GraphQLNamedType>();
  for (const root of ROOTS) {
    const rootType = {
      query: schema.getQueryType(),
      mutation: schema.getMutationType(),
      subscription: schema.getSubscriptionType(),
    }[root.kind];
    if (!rootType) continue;
    rootTypes.add(rootType);
    const fields = Object.values(rootType.getFields());
    if (fields.length === 0) continue;
    doc.groups.push({ key: root.key, name: root.name, description: rootType.description ?? "" });
    for (const field of fields) {
      const key = `${root.kind} ${field.name}`;
      const variables: Record<string, unknown> = {};
      const params = field.args.map((arg) => {
        const paramSchema = schemaOf(arg.type, []);
        const value = defaultOf(arg);
        if (value !== undefined) paramSchema.default = value;
        if (arg.deprecationReason != null) paramSchema.deprecated = true;
        const example = inputExample(arg.type, []);
        // Only what the field needs is sent: a made-up cursor or filter fails, and unset ones take their defaults.
        if (isRequiredArgument(arg)) variables[arg.name] = example;
        return {
          name: arg.name,
          in: "argument" as const,
          required: isRequiredArgument(arg),
          description: arg.description ?? "",
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
        description: field.description ?? "",
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
