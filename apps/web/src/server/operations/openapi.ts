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
      summary: operation.summary,
      tags: [operation.name.split(".")[0]],
      ...(parameters.length > 0 && { parameters }),
      ...(body && { requestBody: body }),
      ...(operation.scope === "write" && { description: "Needs a read + write key." }),
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
        "Read and change a project's feedback. Authenticate with a project API key (Settings → API keys): `Authorization: Bearer tuti_…`. Up to 600 requests a minute per key.",
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
