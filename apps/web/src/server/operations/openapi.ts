import { z } from "zod";

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
 * An operation's title: its summary's first clause ("Rename the project (the name its portal…)" → "Rename the project"),
 * at most about 100 characters. OpenAPI's `summary` is a short title, and docs built from the spec (an API reference
 * in a help center, Tuti's own included) make each endpoint's heading and address from it; the whole text goes in
 * `description`.
 */
export function shortTitle(summary: string): string {
  let title = summary;
  for (const separator of [". ", ": ", "; ", " (", ", ", " — "]) {
    const at = title.indexOf(separator);
    if (at > 0) title = title.slice(0, at);
  }
  if (title.length <= 100) return title;
  const cut = title.slice(0, 100);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 50 ? cut.lastIndexOf(" ") : 100)}…`;
}

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
      summary: shortTitle(operation.summary),
      description: `${plainMarkdown(operation.summary)}${operation.scope === "write" ? "\n\nNeeds a read + write key." : ""}`,
      tags: [operation.name.split(".")[0]],
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
      description:
        "Read and change a project's feedback. Authenticate with a project API key (Settings → Developers): `Authorization: Bearer tuti_…`. Up to 600 requests a minute per key.",
    },
    servers: [{ url: serverUrl }],
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
