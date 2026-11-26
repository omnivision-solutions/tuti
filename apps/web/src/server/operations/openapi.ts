import { z } from "zod";

import { API_RATE_LIMIT } from "@/lib/api-keys";

import { operations } from "./index";

type JsonSchema = { properties?: Record<string, JsonSchema>; required?: string[]; description?: string; [key: string]: unknown };

/**
 * A zod type as JSON Schema. Zod bounds every `.int()` by the safe integers (±2^53 − 1), which isn't a limit anyone
 * set: those bounds go, so the docs don't print "at most 9007199254740991". Real ones (`.max(100)`) stay.
 */
function toJsonSchema(type: z.ZodType, io: "input" | "output"): JsonSchema {
  const schema = z.toJSONSchema(type, {
    io,
    unrepresentable: "any",
    override: ({ jsonSchema }) => {
      for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
        if (Math.abs(jsonSchema[key] as number) === Number.MAX_SAFE_INTEGER) delete jsonSchema[key];
      }
    },
  }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

/** An operation's input as JSON Schema (what callers send, before defaults and coercion). */
export function inputSchema(operation: (typeof operations)[number]): JsonSchema {
  return toJsonSchema(operation.input, "input");
}

/**
 * What an operation returns as JSON Schema, or null when it doesn't say: self-contained, its named types (`.meta({ id })`)
 * under `$defs`, as MCP's `outputSchema` takes it.
 */
export function outputSchema(operation: (typeof operations)[number]): JsonSchema {
  return opened(toJsonSchema(operation.output, "output")) as JsonSchema;
}

/** Keys whose values are data, not schemas: left as they are. */
const DATA = new Set(["examples", "example", "default", "const", "enum"]);

/**
 * Rewrites a JSON Schema node by node: `change` gets each schema (not a map of names to schemas like `properties`, where
 * a field may be called "enum", nor data like `examples`) after its parts are rewritten.
 */
function eachSchema(value: unknown, change: (schema: Record<string, unknown>) => Record<string, unknown>, named = false): unknown {
  if (Array.isArray(value)) return value.map((item) => eachSchema(item, change));
  if (value === null || typeof value !== "object") return value;
  const parts = Object.entries(value).map(([key, field]) => [
    key,
    named ? eachSchema(field, change) : DATA.has(key) ? field : eachSchema(field, change, key === "properties" || key === "$defs" || key === "patternProperties"),
  ]);
  return named ? Object.fromEntries(parts) : change(Object.fromEntries(parts) as Record<string, unknown>);
}

/**
 * A result may carry more than its output says (a field the next release added, kept in stored JSON), so no object is
 * closed: zod's `additionalProperties: false` goes. Without closed objects a union's branches can overlap, so `oneOf`
 * (zod's discriminated unions) becomes `anyOf`: a result fits when it fits one.
 */
export function opened(schema: unknown): unknown {
  return eachSchema(schema, ({ additionalProperties, oneOf, ...rest }) => ({
    ...rest,
    ...(additionalProperties !== undefined && additionalProperties !== false && { additionalProperties }),
    ...(oneOf !== undefined && (rest.anyOf === undefined ? { anyOf: oneOf } : { allOf: [...((rest.allOf as unknown[]) ?? []), { anyOf: oneOf }] })),
  }));
}

/**
 * For agents: clients check a tool's result against MCP's `outputSchema`, so a value a list doesn't have yet (a feature
 * or a status the other release wrote, during a deploy) mustn't fail the call. Each `enum` and `const` becomes
 * `examples`, which name the values without checking them; the spec keeps them for readers.
 */
export function forAgents(schema: unknown): unknown {
  return eachSchema(schema, ({ enum: values, const: only, examples, ...rest }) => {
    const named = [...((examples as unknown[]) ?? []), ...(Array.isArray(values) ? values : []), ...(only !== undefined ? [only] : [])];
    return { ...rest, ...(named.length > 0 && { examples: [...new Set(named)] }) };
  });
}

/** MCP's `outputSchema`: the output, opened, with its lists of values named for agents rather than checked. */
export function agentOutputSchema(operation: (typeof operations)[number]): JsonSchema {
  return forAgents(outputSchema(operation)) as JsonSchema;
}

/** Each error status: its response's name in the spec, what it means, a short form for MCP, and an example body. */
const ERRORS = {
  400: {
    name: "BadRequest",
    description: "The request isn't valid: a field is missing, has the wrong type or is out of range, or the body isn't a JSON object. The message names the field.",
    brief: "invalid input",
    example: { code: "invalid_input", message: "title: Title is too short" },
  },
  401: {
    name: "Unauthorized",
    description: "No API key was sent, or it isn't valid: it was revoked, or whoever created it left the team.",
    brief: "invalid key",
    example: { code: "unauthorized", message: "This API key isn't valid or was revoked" },
  },
  402: {
    name: "PaymentRequired",
    description: "The project's plan doesn't include this or is at its limit, it's out of credits, or a payment didn't go through. The message says what's needed.",
    brief: "needs a plan, credits or a payment",
    example: { code: "plan_required", message: "A custom domain needs the Pro plan. See Settings → Billing." },
  },
  403: {
    name: "Forbidden",
    description: "It isn't allowed: the key is read-only, its creator isn't a project owner or admin where only they may, only a person can do it in the app, a setting is off, or someone's address isn't confirmed. The code says which.",
    brief: "not allowed",
    example: { code: "forbidden", message: "This key can only read. Create a read + write key to change things." },
  },
  404: { name: "NotFound", description: "Nothing by that name, number or id in this project.", brief: "not found", example: { code: "not_found", message: "No such post" } },
  409: {
    name: "Conflict",
    description: "It can't be done as things are now: for example the post was merged, or someone changed it meanwhile. The code says which.",
    brief: "conflict",
    example: { code: "merged", message: "This post was merged into another one; vote there instead" },
  },
  429: {
    name: "RateLimited",
    description: `Too many requests: past ${API_RATE_LIMIT} a minute per key, try again after the seconds in the Retry-After header. Some operations have limits of their own (their description gives them), whose 429 has no Retry-After.`,
    brief: "rate limited",
    example: { code: "rate_limited", message: `Up to ${API_RATE_LIMIT} requests a minute per key` },
  },
  502: {
    name: "BadGateway",
    description: "A service Tuti uses failed (the AI model, Stripe, DNS or email). Try again in a moment.",
    brief: "a service Tuti uses failed",
    example: { code: "ai_failed", message: "The AI couldn't write a draft. Try again in a moment." },
  },
  503: {
    name: "Unavailable",
    description: "This feature isn't set up on this server (for example AI or billing), or Tuti couldn't start the work just now: try again in a moment.",
    brief: "not set up on this server, or try again in a moment",
    example: { code: "ai_unavailable", message: "AI isn't set up on this server" },
  },
  // Any operation, but never on purpose: not one of the statuses an operation lists (errorStatuses), so tests fail on it.
  500: {
    name: "InternalError",
    description: "Something went wrong on Tuti's side. Try again in a moment.",
    brief: "something went wrong",
    example: { code: "internal_error", message: "Something went wrong" },
  },
} as const;

/**
 * The error statuses an operation answers with: 401 and 429 always, 400 when it takes input (anything but a GET reads
 * a JSON body it's sent), 403 when it writes or is for owners and admins, 404 when its path names something, and what it
 * declares (`errors`: a 404 too where its input, not its path, names what may not be there).
 */
export function errorStatuses(operation: (typeof operations)[number]): Exclude<keyof typeof ERRORS, 500>[] {
  const takesInput = Object.keys(inputSchema(operation).properties ?? {}).length > 0 || operation.method !== "GET";
  return [
    ...(takesInput ? [400 as const] : []),
    401 as const,
    ...(operation.scope === "write" || operation.access === "admin" || operation.access === "owner" ? [403 as const] : []),
    ...(pathParams(operation.path).length > 0 ? [404 as const] : []),
    429 as const,
    ...(operation.errors ?? []),
  ]
    .filter((status, at, all) => all.indexOf(status) === at)
    .sort((a, b) => a - b);
}

/**
 * MCP's line about a tool's errors: those a call can give. A bad key and the key's own rate limit fail the whole request;
 * an operation's own limit (a declared 429) fails only the call, so it's listed.
 */
export function errorsLine(operation: (typeof operations)[number]): string {
  const statuses = errorStatuses(operation).filter((status) => status !== 401 && (status !== 429 || operation.errors?.includes(429)));
  return statuses.length === 0 ? "" : `Errors: ${statuses.map((status) => `${status} ${ERRORS[status].brief}`).join(", ")}.`;
}

/**
 * A value made of each field's first example (`.meta({ examples })`), for the spec's response example; fields without
 * one are left out, and undefined when nothing has one. `defs`: the schema's `$defs`, which its `$ref`s name.
 */
export function exampleOf(schema: JsonSchema, defs: Record<string, JsonSchema> = {}): unknown {
  if (typeof schema.$ref === "string") {
    const target = defs[schema.$ref.replace("#/$defs/", "")];
    return target && exampleOf(target, defs);
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (schema.type === "array" && schema.items) {
    const item = exampleOf(schema.items as JsonSchema, defs);
    return item === undefined ? undefined : [item];
  }
  if (schema.properties) {
    const fields = Object.entries(schema.properties).flatMap(([name, field]) => {
      const value = exampleOf(field, defs);
      return value === undefined ? [] : [[name, value] as const];
    });
    return fields.length > 0 ? Object.fromEntries(fields) : undefined;
  }
  for (const choice of [...((schema.anyOf ?? schema.oneOf ?? []) as JsonSchema[])]) {
    const value = exampleOf(choice, defs);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Path parameters of an operation, e.g. ["number"] for /posts/{number}. */
export const pathParams = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

/**
 * An operation's text as CommonMark, which OpenAPI's `description` is: written as plain text, so what Markdown would
 * read as markup outside its code spans (`<address>` as a tag, `tabs.*` as emphasis) is escaped.
 */
export function plainMarkdown(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, at) => (at % 2 === 1 ? part : part.replace(/[\\*_<>[\]#]/g, "\\$&")))
    .join("");
}

/**
 * The spec's groups, in order, each with what it's for; an operation's group is its name's first part's ("posts.list"
 * → Feedback). A test fails for a first part that isn't here.
 */
export const groups = [
  {
    name: "Feedback",
    description: "Boards of posts that people vote and comment on, and the roadmap made from them.",
    prefixes: ["boards", "posts", "comments", "votes", "duplicates", "subscriptions", "roadmap", "links"],
  },
  {
    name: "Changelog",
    description: "Release notes the team writes (or has AI draft), publishes on the portal for readers to react to, and emails to subscribers.",
    prefixes: ["changelog", "changelogComments", "changelogStyle", "changelogSubscribers"],
  },
  {
    name: "Docs",
    description: "The help center: articles in collections and tabs, search, and the AI answers drawn from them.",
    prefixes: ["articles", "collections", "tabs", "docs", "assistant"],
  },
  {
    name: "API references",
    description: "API references in the docs, read from an OpenAPI or GraphQL spec that's uploaded, at a URL or in a GitHub repository.",
    prefixes: ["apiReferences", "githubRepositories"],
  },
  {
    name: "Inbox",
    description: "Conversations with your users, from the widget and email, the inbox's settings, spam filter and workflows, and phone notifications.",
    prefixes: ["conversations", "workflows", "support", "spam", "devices", "notifications"],
  },
  {
    name: "Autopilot",
    description: "Merged pull requests and the updates Autopilot proposes from them to posts and articles, and how it's tuned.",
    prefixes: ["codeChanges", "codeChangeActions", "codeChangesTuning"],
  },
  {
    name: "Users",
    description: "The people your app signs in, the companies they're at, reader groups, private portal readers and email preferences.",
    prefixes: ["users", "companies", "groups", "portalReaders", "emailPreferences", "propertyFormats"],
  },
  {
    name: "Portal",
    description: "The public site for feedback, changelog and docs: who may read it, its address, redirects, branding, widget and languages.",
    prefixes: ["portal", "site", "domain", "redirects", "branding", "widget", "languages"],
  },
  {
    name: "Project",
    description: "The project itself: its name, team, imports from other tools, reports, AI models, and screenshots of your app taken by an agent.",
    prefixes: ["project", "team", "imports", "reports", "aiModels", "screenshotSettings", "screenshots"],
  },
  {
    name: "Billing",
    description: "The project's plan, licence, AI usage and credits.",
    prefixes: ["plan", "license", "usage", "credits"],
  },
] as const;

/** An operation's group's name, or undefined for a first part no group has. */
export const groupOf = (operation: { name: string }) =>
  groups.find((group) => (group.prefixes as readonly string[]).includes(operation.name.split(".")[0]!))?.name;

/** The spec's overview (`info.description`): what a reader needs before the first request. Help centers show it first. */
const overview = `Read and change a Tuti project from code: its feedback, changelog, docs, inbox, Autopilot, users and portal. Each request acts on the project its key belongs to.

## Getting a key

Project owners and admins create keys in the app, in Settings → Developers. A **Read only** key runs the operations that read; a **Read and write** key runs the rest too, except the few that only a person can run, in the app (their description says so). The key is shown once, when it's created.

## Authentication

Send the key as a bearer token with every request:

\`\`\`
Authorization: Bearer tuti_…
\`\`\`

A key acts as the team, with its creator's current role: operations for owners and admins work only while its creator is one, and the key stops working when it's revoked or its creator leaves the team.

Tuti's mobile app signs in as a teammate instead of with a key: it sends the teammate's session as the bearer token, with the project's slug in a \`Tuti-Project\` header, and each request acts as that teammate with their role in that project. Only the app's own sign-in gets such a session; there's nothing to set up for it.

## Errors

An error has a status and a JSON body: \`code\` for code to check, \`message\` for people.

\`\`\`json
{ "error": { "code": "not_found", "message": "There's no post #42" } }
\`\`\`

- 400: the input isn't valid
- 401: no key, or one that no longer works
- 402: the project's plan doesn't include it or is at its limit, it's out of credits, or a payment didn't go through
- 403: it isn't allowed (a read-only key, its creator's role, one only a person can run in the app, or a setting that's off)
- 404: no such thing
- 409: it conflicts with how things are now
- 429: too many requests
- 500: something went wrong on Tuti's side
- 502: a service Tuti uses failed (e.g. the AI model)
- 503: a feature isn't set up on this server, or Tuti couldn't start the work just now (try again in a moment)

## Paging

Lists that page take \`limit\` and \`cursor\` and return \`nextCursor\`: send it back as \`cursor\` for the next page; \`null\` means there are no more. Other lists return everything at once, or at most a fixed number (their description gives it).

## Rate limits

Up to ${API_RATE_LIMIT} requests a minute per key. Past that, requests get a 429 with a \`Retry-After\` header: the seconds until the next minute starts. Some operations have limits of their own (their description gives them); their 429 has no \`Retry-After\`.`;

/** The OpenAPI 3.1 description of the REST API, generated from the operations so it can't drift from them. */
export function openApiSpec(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  // Types several operations return (`.meta({ id })`), by name.
  const schemas: Record<string, JsonSchema> = {};
  for (const operation of operations) {
    const schema = inputSchema(operation);
    const inPath = pathParams(operation.path);
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const others = Object.keys(properties).filter((name) => !inPath.includes(name));
    // The operation's example request: its values for parameters, the rest the body's.
    const example = operation.example ?? {};
    const exampleFor = (name: string) => (Object.hasOwn(example, name) ? { example: example[name] } : {});
    const parameters = [
      ...inPath.map((name) => ({ name, in: "path", required: true, schema: properties[name], ...exampleFor(name) })),
      ...(operation.method === "GET"
        ? others.map((name) => ({ name, in: "query", required: required.has(name), schema: properties[name], ...exampleFor(name) }))
        : []),
    ];
    const bodyExample = Object.fromEntries(others.filter((name) => Object.hasOwn(example, name)).map((name) => [name, example[name]]));
    const body =
      operation.method !== "GET" && others.length > 0
        ? {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: Object.fromEntries(others.map((name) => [name, properties[name]])),
                  required: others.filter((name) => required.has(name)),
                  // Rules across fields, declared with .meta() next to the operation's refine.
                  ...(schema.anyOf !== undefined && { anyOf: schema.anyOf }),
                  ...(schema.oneOf !== undefined && { oneOf: schema.oneOf }),
                },
                ...(Object.keys(bodyExample).length > 0 && { example: bodyExample }),
              },
            },
          }
        : undefined;

    paths[operation.path] ??= {};
    paths[operation.path]![operation.method.toLowerCase()] = {
      operationId: operation.name,
      summary: operation.title,
      description: `${plainMarkdown(operation.summary)}${operation.scope === "write" ? "\n\nNeeds a read + write key." : ""}`,
      tags: [groupOf(operation)],
      ...(parameters.length > 0 && { parameters }),
      ...(body && { requestBody: body }),
      responses: {
        "200": ok(operation, schemas),
        ...Object.fromEntries(
          [...errorStatuses(operation), 500 as const].map((status) => [String(status), { $ref: `#/components/responses/${ERRORS[status].name}` }]),
        ),
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Tuti API",
      version: "1",
      description: overview,
    },
    servers: [{ url: serverUrl }],
    tags: groups.map(({ name, description }) => ({ name, description })),
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "A project API key (tuti_…)" } },
      schemas: {
        ...schemas,
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", description: "What went wrong, for code to check: stays the same" },
                message: { type: "string", description: "What went wrong, for a person: may change" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
      responses: Object.fromEntries(
        Object.values(ERRORS).map(({ name, description, example }) => [
          name,
          { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: example } } } },
        ]),
      ),
    },
  };
}

/**
 * An operation's 200 response: what it returns, its named types moved to the spec's `schemas` (one name is one type
 * across operations), with an example made of its fields' examples.
 */
function ok(operation: (typeof operations)[number], schemas: Record<string, JsonSchema>) {
  const output = outputSchema(operation);
  const { $defs = {}, ...schema } = output as JsonSchema & { $defs?: Record<string, JsonSchema> };
  const example = exampleOf(schema, $defs);
  const inSpec = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('"#/$defs/', '"#/components/schemas/')) as T;
  for (const [name, type] of Object.entries(inSpec($defs))) {
    if (schemas[name] && JSON.stringify(schemas[name]) !== JSON.stringify(type)) {
      throw new Error(`Two types are named ${name} (${operation.name}'s and another's): give one another id`);
    }
    schemas[name] = type;
  }
  return {
    description: typeof schema.description === "string" ? schema.description : "OK",
    content: { "application/json": { schema: inSpec(schema), ...(example !== undefined && { example }) } },
  };
}
