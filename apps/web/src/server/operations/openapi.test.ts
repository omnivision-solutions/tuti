import { readFileSync, writeFileSync } from "node:fs";

import { readOpenApi } from "@tuti/shared/api-reference";
import { expect, test, vi } from "vitest";

// Loading the operations loads the app's auth, which reads its addresses: placeholders (unit tests have none).
vi.hoisted(() => {
  process.env.APP_URL = "http://tuti.localhost:3100";
  process.env.PORTAL_URL_TEMPLATE = "http://{project}.localhost:3100";
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
});

import { type OperationName, operations } from "./index";
import { errorStatuses, errorsLine, inputSchema, openApiSpec, outputSchema, pathParams } from "./openapi";

/**
 * How the operations read in the API reference and MCP (docs/plan.md, "Tuti's API spec that reads well"): an operation
 * gives a short summary (at most 300 characters) and says what it returns (`output`), with a description on each field
 * it takes and returns, and nothing its summary told an agent before is lost.
 */

/**
 * Operations whose summary isn't rewritten yet (B3–B10, one area each): they may still be long, and say nothing of what
 * they return. An area's step takes its names off as it rewrites them; the list goes once it's empty.
 */
const notRewrittenYet = new Set<OperationName>([
  // B3: Feedback
  "boards.list",
  "comments.create",
  "comments.like",
  "comments.list",
  "duplicates.dismiss",
  "duplicates.list",
  "links.remove",
  "posts.create",
  "posts.get",
  "posts.list",
  "posts.merge",
  "posts.update",
  "roadmap.get",
  "subscriptions.set",
  "votes.set",
  // B4: Changelog
  "changelog.create",
  "changelog.delete",
  "changelog.draft",
  "changelog.get",
  "changelog.list",
  "changelog.publish",
  "changelog.react",
  "changelog.rewrite",
  "changelog.seen",
  "changelog.unpublish",
  "changelog.update",
  "changelogStyle.get",
  "changelogStyle.update",
  // B5: Docs
  "articles.create",
  "articles.delete",
  "articles.discardChanges",
  "articles.feedback",
  "articles.get",
  "articles.list",
  "articles.publish",
  "articles.publishChanges",
  "articles.reorder",
  "articles.restore",
  "articles.revisions",
  "articles.search",
  "articles.unpublish",
  "articles.update",
  "articles.verifications",
  "articles.verify",
  "articles.verifyAll",
  "assistant.get",
  "assistant.update",
  "collections.create",
  "collections.delete",
  "collections.list",
  "collections.reorder",
  "collections.update",
  "docs.ask",
  "docs.dismissGap",
  "docs.escalate",
  "docs.insights",
  "tabs.create",
  "tabs.delete",
  "tabs.list",
  "tabs.reorder",
  "tabs.update",
  // B6: API references
  "apiReferences.create",
  "apiReferences.delete",
  "apiReferences.get",
  "apiReferences.list",
  "apiReferences.replace",
  "apiReferences.sync",
  "apiReferences.update",
  "githubRepositories.list",
  // B7: Inbox
  "conversations.create",
  "conversations.get",
  "conversations.linkPost",
  "conversations.list",
  "conversations.markRead",
  "conversations.reply",
  "conversations.suggestReply",
  "conversations.summarize",
  "conversations.unlinkPost",
  "conversations.update",
  "support.checkEmailDomain",
  "support.get",
  "support.removeEmailDomain",
  "support.setEmailDomain",
  "support.update",
  // B8: Autopilot
  "codeChangeActions.apply",
  "codeChangeActions.applyMany",
  "codeChangeActions.dismiss",
  "codeChangeActions.publishNow",
  "codeChangeActions.stop",
  "codeChangeActions.undo",
  "codeChanges.analyse",
  "codeChanges.get",
  "codeChanges.list",
  "codeChanges.resume",
  "codeChanges.target",
  "codeChanges.targets",
  "codeChangesTuning.get",
  "codeChangesTuning.update",
  // B9: Users
  "companies.list",
  "emailPreferences.update",
  "groups.create",
  "groups.delete",
  "groups.list",
  "groups.update",
  "portalReaders.add",
  "portalReaders.list",
  "portalReaders.remove",
  "propertyFormats.update",
  "users.get",
  "users.list",
  "users.sync",
  // B10: Portal, Project and Billing
  "aiModels.get",
  "aiModels.update",
  "branding.get",
  "branding.update",
  "credits.get",
  "credits.topUp",
  "domain.get",
  "domain.remove",
  "domain.set",
  "domain.verify",
  "imports.get",
  "imports.start",
  "license.check",
  "plan.badge",
  "plan.get",
  "plan.manage",
  "plan.subscribe",
  "portal.get",
  "portal.update",
  "project.get",
  "project.update",
  "redirects.create",
  "redirects.delete",
  "redirects.list",
  "reports.get",
  "site.get",
  "site.remove",
  "site.set",
  "site.verify",
  "usage.get",
  "widget.get",
  "widget.update",
]);

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

test("rewritten operations are short and say what they return", () => {
  const names = new Set(operations.map((operation) => operation.name));
  expect([...notRewrittenYet].filter((name) => !names.has(name)), "notRewrittenYet names operations that don't exist").toEqual([]);
  for (const operation of operations.filter((operation) => !notRewrittenYet.has(operation.name as OperationName))) {
    expect(operation.summary.length, `${operation.name}'s summary is over 300 characters`).toBeLessThanOrEqual(300);
    expect(operation.output, `${operation.name} has no output`).toBeDefined();
    const output = outputSchema(operation)!;
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

test("every field of a rewritten operation's output has an example, optional ones too", () => {
  for (const operation of operations.filter((operation) => operation.output && !notRewrittenYet.has(operation.name as OperationName))) {
    const schema = outputSchema(operation)! as Schema;
    const missing = withoutExample(schema, (schema.$defs ?? {}) as Record<string, Schema>, "");
    expect(missing, `${operation.name}: these output fields have no .meta({ examples }), so the response example leaves them out`).toEqual([]);
  }
});

test("every field of a rewritten operation's output has an example, so the spec's response example is whole", () => {
  const spec = openApiSpec("https://tuti.example.com/api/v1");
  for (const operation of operations.filter((operation) => operation.output && !notRewrittenYet.has(operation.name as OperationName))) {
    const ok = (spec.paths[operation.path]![operation.method.toLowerCase()] as { responses: Record<string, { content: Record<string, { example?: unknown }> }> })
      .responses["200"]!;
    const example = ok.content["application/json"]!.example;
    const parsed = operation.output!.safeParse(example);
    expect(parsed.error?.issues ?? [], `${operation.name}'s response example (fields without .meta({ examples }) are left out of it)`).toEqual([]);
    expect(parsed.data, `${operation.name}'s response example has fields its output doesn't`).toEqual(example);
  }
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
  // Settings for owners and admins on a paid plan, checked with the DNS.
  expect(responses("/domain", "post")).toEqual(["200", "400", "401", "402", "403", "409", "429", "500"]);
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
