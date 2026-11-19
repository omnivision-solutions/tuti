import { z } from "zod";

import { API_RATE_LIMIT } from "@/lib/api-keys";

import { operations } from "./index";

type JsonSchema = { properties?: Record<string, JsonSchema>; required?: string[]; description?: string; [key: string]: unknown };

/** An operation's input as JSON Schema (what callers send, before defaults and coercion). */
export function inputSchema(operation: (typeof operations)[number]): JsonSchema {
  const schema = z.toJSONSchema(operation.input, { io: "input", unrepresentable: "any" }) as JsonSchema;
  delete schema.$schema;
  return schema;
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
    description: "Release notes the team writes (or has AI draft) and publishes on the portal, where readers react to them.",
    prefixes: ["changelog", "changelogStyle"],
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
    description: "Conversations with the people who use your product, from the widget and email, and the support inbox's settings.",
    prefixes: ["conversations", "support"],
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
    description: "The public site for feedback, changelog and docs: who may read it, its address, redirects, branding and widget.",
    prefixes: ["portal", "site", "domain", "redirects", "branding", "widget"],
  },
  {
    name: "Project",
    description: "The project itself: its name, team, imports from other tools, reports and AI models.",
    prefixes: ["project", "team", "imports", "reports", "aiModels"],
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

Project owners and admins create keys in the app, in Settings → Developers. A **Read only** key runs the operations that read; a **Read and write** key runs them all. The key is shown once, when it's created.

## Authentication

Send the key as a bearer token with every request:

\`\`\`
Authorization: Bearer tuti_…
\`\`\`

A key acts as the team, with its creator's current role: operations for owners and admins work only while its creator is one, and the key stops working when it's revoked or its creator leaves the team.

## Errors

An error has a status and a JSON body: \`code\` for code to check, \`message\` for people.

\`\`\`json
{ "error": { "code": "not_found", "message": "There's no post #42" } }
\`\`\`

- 400: the input isn't valid
- 401: no key, or one that no longer works
- 402: the project's plan doesn't include it, or it's out of AI credits
- 403: the key may not do it (a read-only key, or its creator's role)
- 404: no such thing
- 409: it conflicts with how things are now
- 429: too many requests
- 500: something went wrong on Tuti's side
- 502: a service Tuti uses failed (e.g. the AI model)
- 503: a feature isn't set up on this server

## Paging

Lists that page take \`limit\` and \`cursor\` and return \`nextCursor\`: send it back as \`cursor\` for the next page; \`null\` means there are no more. Other lists return everything at once, or at most a fixed number (their description gives it).

## Rate limits

Up to ${API_RATE_LIMIT} requests a minute per key. Past that, requests get a 429 with a \`Retry-After\` header: the seconds until the next minute starts.`;

/** The OpenAPI 3.1 description of the REST API, generated from the operations so it can't drift from them. */
export function openApiSpec(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const schema = inputSchema(operation);
    const inPath = pathParams(operation.path);
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const others = Object.keys(properties).filter((name) => !inPath.includes(name));
    const parameters = [
      ...inPath.map((name) => ({ name, in: "path", required: true, schema: properties[name] })),
      ...(operation.method === "GET"
        ? others.map((name) => ({ name, in: "query", required: required.has(name), schema: properties[name] }))
        : []),
    ];
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
                },
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
        "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
        default: { $ref: "#/components/responses/Error" },
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
      responses: {
        Error: {
          description: "An error: 400 bad input, 401 missing or revoked key, 403 read-only key, 404 not found, 409 conflict, 429 rate limited, 502 a service Tuti uses failed (e.g. the AI model), 503 a feature isn't set up on this server",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "object",
                    properties: { code: { type: "string" }, message: { type: "string" } },
                    required: ["code", "message"],
                  },
                },
                required: ["error"],
              },
            },
          },
        },
      },
    },
  };
}
