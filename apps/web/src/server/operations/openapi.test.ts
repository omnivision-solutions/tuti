import { readFileSync, writeFileSync } from "node:fs";

import { readOpenApi } from "@tuti/shared/api-reference";
import { expect, test, vi } from "vitest";
import { z } from "zod";

// Loading the operations loads the app's auth, which reads its addresses: placeholders (unit tests have none).
vi.hoisted(() => {
  process.env.APP_URL = "http://tuti.localhost:3100";
  process.env.PORTAL_URL_TEMPLATE = "http://{project}.localhost:3100";
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
});

import { operations } from "./index";
import { agentOutputSchema, errorStatuses, errorsLine, forAgents, inputSchema, opened, openApiSpec, outputSchema, pathParams } from "./openapi";

/**
 * How the operations read in the API reference and MCP (docs/plan.md, "Tuti's API spec that reads well"): an operation
 * gives a short summary (at most 300 characters) and says what it returns (`output`), with a description on each field
 * it takes and returns, and nothing its summary told an agent before is lost.
 */

/**
 * agent-context.json: each operation's words (4 letters or more) as its summary had them before the rewrite. Each must
 * still be in its summary, or in its input's or output's schema (a field's description or name, or a value it takes),
 * so what an agent read before is still there. Dropping one on purpose: run this file with AGENT_CONTEXT=write
 * (`AGENT_CONTEXT=write pnpm exec vitest run --project unit apps/web/src/server/operations/openapi.test.ts`), which
 * keeps each operation's words that are still there and adds new operations' summaries', and say in the PR which words
 * went and why.
 */
const CONTEXT_FILE = new URL("./agent-context.json", import.meta.url);

/** Words that carry nothing an agent could lose: a rewrite needn't keep them. */
const FILLER = new Set(
  ("about after again also aren been before being both could didn does doesn each from have here into isn just more most much once only " +
    "other others over same should some such than that their them then there these they this those through until very wasn were what when " +
    "where which while will with within without would your").split(" "),
);

/** A text's significant words, as agent-context.json holds them: lowercase letters and digits, 4 or more, not filler, each once, sorted. */
const wordsOf = (text: string) =>
  [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((word) => word.length >= 4 && !FILLER.has(word)).sort();

/** What an agent reads about an operation besides its summary: its schemas' descriptions, field names and values. */
function schemaText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaText);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    ...(key === "description" && typeof inner === "string" ? [inner] : []),
    ...(key === "properties" && typeof inner === "object" && inner !== null ? Object.keys(inner) : []),
    ...((key === "enum" || key === "const") ? [inner].flat().filter((v): v is string => typeof v === "string") : []),
    ...schemaText(inner),
  ]);
}

const operationWords = (operation: (typeof operations)[number]) =>
  new Set(wordsOf([operation.summary, ...schemaText(inputSchema(operation)), ...schemaText(outputSchema(operation))].join(" ")));

test("nothing an operation's summary told an agent is lost", () => {
  const context = JSON.parse(readFileSync(CONTEXT_FILE, "utf8")) as Record<string, string[]>;
  if (process.env.AGENT_CONTEXT === "write") {
    const written = Object.fromEntries(
      operations
        .map((operation) => {
          const now = operationWords(operation);
          return [operation.name, context[operation.name]?.filter((word) => now.has(word)) ?? wordsOf(operation.summary)] as const;
        })
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    writeFileSync(CONTEXT_FILE, `{\n${Object.entries(written).map(([name, words]) => `  ${JSON.stringify(name)}: ${JSON.stringify(words)}`).join(",\n")}\n}\n`);
    return;
  }
  expect(Object.keys(context).sort(), "agent-context.json lists every operation: AGENT_CONTEXT=write adds a new one").toEqual(
    operations.map((operation) => operation.name).sort(),
  );
  const lost = operations.flatMap((operation) => {
    const now = operationWords(operation);
    const gone = context[operation.name]!.filter((word) => !now.has(word));
    return gone.length > 0 ? [`${operation.name}: ${gone.join(", ")}`] : [];
  });
  expect(
    lost,
    "These words are in neither the operation's summary nor its fields' descriptions. Put them back, or, if dropping them is on purpose, update agent-context.json in this PR (AGENT_CONTEXT=write) and say why",
  ).toEqual([]);
});

test("every operation is short and says what it returns", () => {
  for (const operation of operations) {
    expect(operation.summary.length, `${operation.name}'s summary is over 300 characters`).toBeLessThanOrEqual(300);
    const output = outputSchema(operation);
    expect(output.description, `${operation.name}'s output has no .describe(): the 200 response's description`).toEqual(expect.any(String));
  }
});

type Schema = { [key: string]: unknown; $ref?: string; examples?: unknown[]; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[] };

/** The fields of an output schema with no example, as paths (`posts[].eta`): the response example would leave them out. */
function withoutExample(schema: Schema, defs: Record<string, Schema>, path: string, seen = new Set<string>()): string[] {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    if (seen.has(name)) return [];
    return withoutExample(defs[name] ?? {}, defs, path, new Set([...seen, name]));
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return [];
  if (schema.properties) {
    return Object.entries(schema.properties).flatMap(([name, field]) => withoutExample(field, defs, path ? `${path}.${name}` : name, seen));
  }
  if (schema.items) return withoutExample(schema.items, defs, `${path}[]`, seen);
  const choices = (schema.anyOf ?? schema.oneOf ?? []).filter((choice) => choice.type !== "null");
  if (choices.length > 0) {
    const each = choices.map((choice) => withoutExample(choice, defs, path, seen));
    return each.find((missing) => missing.length === 0) ?? each[0]!;
  }
  return [path || "(the output itself)"];
}

test("every field of an operation's output has an example, optional ones too", () => {
  for (const operation of operations) {
    const schema = outputSchema(operation) as Schema;
    const missing = withoutExample(schema, (schema.$defs ?? {}) as Record<string, Schema>, "");
    expect(missing, `${operation.name}: these output fields have no .meta({ examples }), so the response example leaves them out`).toEqual([]);
  }
});

test("an operation's response example is whole and is one it could return", () => {
  const spec = openApiSpec("https://tuti.example.com/api/v1");
  for (const operation of operations) {
    const ok = (spec.paths[operation.path]![operation.method.toLowerCase()] as { responses: Record<string, { content: Record<string, { example?: unknown }> }> })
      .responses["200"]!;
    const example = ok.content["application/json"]!.example;
    const parsed = operation.output.safeParse(example);
    expect(parsed.error?.issues ?? [], `${operation.name}'s response example (fields without .meta({ examples }) are left out of it)`).toEqual([]);
    expect(parsed.data, `${operation.name}'s response example has fields its output doesn't`).toEqual(example);
  }
});

test("rules across fields reach the request body: anyOf and oneOf", () => {
  const spec = openApiSpec("https://tuti.example.com/api/v1");
  const body = (path: string, method: string) =>
    (spec.paths[path]![method] as { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } }).requestBody.content["application/json"]!.schema;
  // A user from your app or an email, not both.
  expect(body("/conversations", "post").oneOf).toEqual([{ required: ["user"] }, { required: ["email"] }]);
  // At least one change.
  expect(body("/conversations/{number}", "patch").anyOf).toEqual(expect.arrayContaining([{ required: ["status"] }]));
});

test("outputs stay open to what the other release writes: no closed objects, and MCP names values without checking them", () => {
  const teamList = operations.find((operation) => operation.name === "team.list")!;
  // A field a later release added, or a role it knows, still passes a client that checks the result.
  expect(JSON.stringify(outputSchema(teamList))).not.toContain('"additionalProperties":false');
  const member = (agentOutputSchema(teamList) as { properties: { team: { items: { $ref?: string } } }; $defs: Record<string, { properties: Record<string, Record<string, unknown>> }> });
  const role = member.$defs.TeamMember!.properties.role!;
  expect(role.enum).toBeUndefined();
  expect(role.examples).toEqual(["owner", "admin", "member"]);
  // Readers of the spec still see the list.
  expect(JSON.stringify(openApiSpec("https://tuti.example.com/api/v1").components)).toContain('"enum":["owner","admin","member"]');
});

test("a discriminated union stays one a result can fit once its objects are open and its values only named", () => {
  const condition = z.discriminatedUnion("op", [
    z.object({ op: z.literal("is"), property: z.string(), value: z.string() }),
    z.object({ op: z.enum(["set", "unset"]), property: z.string() }),
  ]);
  const schema = JSON.stringify(forAgents(opened(z.toJSONSchema(condition, { io: "output" }))));
  // With open objects, { op: "is", property, value } fits both branches: oneOf would refuse it, anyOf takes it.
  expect(schema).not.toMatch(/"oneOf"|"enum"|"const"|"additionalProperties":false/);
  expect(schema).toContain('"anyOf"');
  expect(schema).toContain('"examples":["is"]');
  expect(schema).toContain('"examples":["set","unset"]');
});

test("every example request is one the operation takes", () => {
  for (const operation of operations.filter((operation) => operation.example)) {
    const parsed = operation.input.safeParse(operation.example);
    // Path values aren't in the example: the path has them.
    const issues = (parsed.error?.issues ?? []).filter(
      (issue) => !(issue.path.length === 1 && pathParams(operation.path).includes(String(issue.path[0])) && !(String(issue.path[0]) in operation.example!)),
    );
    expect(issues, `${operation.name}'s example`).toEqual([]);
  }
});

test("errors by status: what every operation can give, and what it declares", () => {
  const spec = openApiSpec("https://tuti.example.com/api/v1");
  const responses = (path: string, method: string) => Object.keys((spec.paths[path]![method] as { responses: object }).responses);
  // A read without input: a bad key and too many requests only.
  expect(responses("/team", "get")).toEqual(["200", "401", "429", "500"]);
  // A write naming a post, which may have been merged.
  expect(responses("/posts/{number}/vote", "post")).toEqual(["200", "400", "401", "403", "404", "409", "429", "500"]);
  // A post on a board that isn't there: a 404 its path doesn't make, so it declares it.
  expect(responses("/posts", "post")).toEqual(["200", "400", "401", "403", "404", "409", "429", "500"]);
  // Settings for owners and admins on a paid plan, on a server where custom domains are set up.
  expect(responses("/domain", "post")).toEqual(["200", "400", "401", "402", "403", "409", "429", "500", "503"]);
  for (const operation of operations) {
    expect(new Set(operation.errors).size, `${operation.name} lists an error twice`).toBe(operation.errors?.length ?? 0);
  }
  expect(errorsLine(operations.find((operation) => operation.name === "votes.set")!)).toBe(
    "Errors: 400 invalid input, 403 not allowed, 404 not found, 409 conflict.",
  );
  expect(errorStatuses(operations.find((operation) => operation.name === "team.list")!)).toEqual([401, 429]);
  // An operation's own limit fails only the tool call, so MCP lists it; the key's limit fails the whole request.
  expect(errorsLine(operations.find((operation) => operation.name === "docs.ask")!)).toContain("429 rate limited");
});

test("the help center reads Tuti's spec whole: what team.list returns, with example values, and each error", () => {
  const read = readOpenApi(JSON.stringify(openApiSpec("https://tuti.example.com/api/v1")));
  if ("error" in read) throw new Error(read.error);
  const { doc } = read;
  expect(doc.warnings).toEqual([]);
  const team = doc.operations.find((operation) => operation.key === "GET /team")!;
  const ok = team.responses.find((response) => response.status === "200")!;
  expect(ok).toMatchObject({
    description: "The project's team",
    schema: { properties: [{ name: "team", description: "Everyone on the team, in the order they joined", items: { ref: "TeamMember" } }] },
    example: { team: [{ name: "Olive Owner", role: "owner" }] },
  });
  expect(doc.types.find((type) => type.name === "TeamMember")?.schema.properties?.map((property) => property.name)).toEqual(["name", "role"]);
  expect(team.responses.find((response) => response.status === "429")).toMatchObject({
    description: expect.stringContaining("600 a minute per key"),
    example: { error: { code: "rate_limited", message: expect.any(String) } },
  });
  // An example request in the spec is the one the page shows.
  const vote = doc.operations.find((operation) => operation.key === "POST /posts/{}/vote")!;
  expect(vote.body?.example).toEqual({ voted: true, author: { id: "user-42" } });
});

test("an integer's bounds are the ones its field sets, not zod's safe-integer range", () => {
  const spec = JSON.stringify(openApiSpec("https://tuti.example.com/api/v1"));
  const tools = JSON.stringify(operations.map((operation) => [inputSchema(operation), agentOutputSchema(operation)]));
  for (const json of [spec, tools]) expect(json).not.toContain(String(Number.MAX_SAFE_INTEGER));
  expect(spec).toContain('"maximum":100');
  expect(spec).toContain('"exclusiveMinimum":0');
});
