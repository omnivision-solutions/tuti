import { buildSchema, graphqlSync, introspectionFromSchema, parse, validate } from "graphql";
import { expect, test, vi } from "vitest";

import { GRAPHQL_INTROSPECTION_QUERY, readGraphql } from "./graphql";
import type { ApiDoc, ApiSchema } from "./types";

const SDL = `
"""
The Acme feedback API.
"""
schema {
  query: Query
  mutation: Mutation
  subscription: Subscription
}

scalar DateTime

enum PostStatus {
  OPEN
  PLANNED
  DONE
}

interface Node {
  id: ID!
}

"A person who posts or comments."
type User implements Node {
  id: ID!
  name: String!
  email: String
  posts(first: Int = 10): [Post!]!
  manager: User
}

"An idea on a board."
type Post implements Node {
  id: ID!
  "Its headline."
  title: String!
  status: PostStatus!
  votes: Int!
  score: Float
  createdAt: DateTime!
  author: User!
  comments(first: Int!): [Comment!]!
  oldTitle: String @deprecated(reason: "Use title.")
  board: Board
}

type Comment implements Node {
  id: ID!
  body: String!
  author: User!
  replies: [Comment!]!
}

type Board {
  name: String!
  owner: User!
}

union SearchResult = Post | User

"What a new post needs."
input CreatePostInput {
  title: String!
  body: String
  status: PostStatus = OPEN
  tags: [String!]
  author: AuthorInput!
}

input AuthorInput {
  email: String!
  name: String
}

input PostFilter {
  status: PostStatus
  and: [PostFilter!]
}

type Viewer {
  account: Account!
}

type Account {
  owner: User!
}

type Query {
  "Every post, newest first."
  posts(filter: PostFilter, first: Int = 20, after: ID): [Post!]!
  post(id: ID!): Post
  search(text: String!): [SearchResult!]!
  node(id: ID!): Node
  viewer: Viewer
  recent(first: Int! = 5, status: PostStatus! = OPEN): [Post!]!
  version: String!
  allPosts: [Post!]! @deprecated(reason: "Use posts.")
}

type CreatePostPayload {
  post: Post
  query: Query!
}

type Mutation {
  createPost(input: CreatePostInput!): Post!
  createPostRelay(input: CreatePostInput!): CreatePostPayload
  deletePost(id: ID!, at: DateTime): Boolean!
}

type Subscription {
  postCreated: Post!
}
`;

function read(text: string, options?: { endpoint?: string }): ApiDoc {
  const result = readGraphql(text, options);
  if ("error" in result) throw new Error(result.error);
  return result.doc;
}

const many = (length: number, one: (n: number) => string) => Array.from({ length }, (_, n) => one(n)).join(" ");
const doc = read(SDL);
const operation = (key: string) => doc.operations.find((one) => one.key === key)!;
const type = (name: string) => doc.types.find((one) => one.name === name)!;
const property = (schema: ApiSchema | undefined, name: string) => schema!.properties!.find((one) => one.name === name)!;

test("a schema file and its introspection result read as the same doc", () => {
  const introspection = introspectionFromSchema(buildSchema(SDL), { schemaDescription: true, inputValueDeprecation: true });
  expect(read(JSON.stringify(introspection))).toEqual(doc);
  expect(read(JSON.stringify({ data: introspection }))).toEqual(doc);
  // A file saved with a byte-order mark first, as some editors do.
  expect(read(`\uFEFF${JSON.stringify(introspection)}`)).toEqual(doc);
  expect(read(`\uFEFF${SDL}`)).toEqual(doc);
});

test("what the introspection query asks for is enough to read", () => {
  const answer = graphqlSync({ schema: buildSchema(SDL), source: GRAPHQL_INTROSPECTION_QUERY });
  const fromEndpoint = read(JSON.stringify(answer));
  expect(fromEndpoint.operations.map((one) => [one.key, one.query])).toEqual(doc.operations.map((one) => [one.key, one.query]));
  expect(fromEndpoint.types.map((one) => one.name)).toEqual(doc.types.map((one) => one.name));
});

test("the doc's own fields: no title or version, the schema's description, the endpoint as its server", () => {
  expect(doc).toMatchObject({ format: "graphql", title: "", version: null, description: "The Acme feedback API.", servers: [], auth: [] });
  expect(read(SDL, { endpoint: "https://api.example.com/graphql" }).servers).toEqual([
    { url: "https://api.example.com/graphql", description: "" },
  ]);
  expect(read("type Query { ok: Boolean }").description).toBe("");
});

test("groups are the root types the schema has", () => {
  expect(doc.groups).toEqual([
    { key: "queries", name: "Queries", description: "" },
    { key: "mutations", name: "Mutations", description: "" },
    { key: "subscriptions", name: "Subscriptions", description: "" },
  ]);
  expect(read("type Query { ok: Boolean }").groups.map((group) => group.key)).toEqual(["queries"]);
  // Root types named something else are still the roots, and aren't listed as types.
  const renamed = read("schema { query: Root } type Root { ok: Boolean } type Query { id: ID }");
  expect(renamed.operations.map((one) => one.key)).toEqual(["query ok"]);
  expect(renamed.types.map((one) => one.name)).toEqual(["Query"]);
});

test("one operation per root field", () => {
  expect(doc.operations.map((one) => one.key)).toEqual([
    "query posts",
    "query post",
    "query search",
    "query node",
    "query viewer",
    "query recent",
    "query version",
    "query allPosts",
    "mutation createPost",
    "mutation createPostRelay",
    "mutation deletePost",
    "subscription postCreated",
  ]);
  expect(operation("query posts")).toMatchObject({
    slug: "posts",
    group: "queries",
    kind: "query",
    path: "posts",
    title: "posts",
    description: "Every post, newest first.",
    deprecated: false,
    auth: [],
    body: null,
  });
  expect(operation("mutation createPost")).toMatchObject({ slug: "create-post", group: "mutations", kind: "mutation" });
  expect(operation("subscription postCreated")).toMatchObject({ group: "subscriptions", kind: "subscription" });
  expect(operation("query allPosts").deprecated).toBe(true);
});

test("arguments are parameters, required when non-null without a default", () => {
  expect(operation("query posts").params).toEqual([
    {
      name: "filter",
      in: "argument",
      required: false,
      description: "",
      schema: expect.objectContaining({ type: "PostFilter", ref: "PostFilter" }),
      // Nothing in it is required, so its first field.
      example: { status: "OPEN" },
    },
    { name: "first", in: "argument", required: false, description: "", schema: { type: "Int", default: 20 }, example: 1 },
    { name: "after", in: "argument", required: false, description: "", schema: { type: "ID" }, example: "1" },
  ]);
  expect(operation("query post").params[0]).toMatchObject({ name: "id", required: true, schema: { type: "ID!" } });
});

test("the response is the returned type, with an example of what the query brings back", () => {
  const [response, ...rest] = operation("query post").responses;
  expect(rest).toEqual([]);
  expect(response).toMatchObject({ status: "data", schema: { type: "Post", ref: "Post", description: "An idea on a board." } });
  expect(response!.example).toEqual({
    id: "1",
    title: "string",
    status: "OPEN",
    votes: 1,
    score: 1.5,
    createdAt: "2026-01-01T00:00:00Z",
    author: { id: "1", name: "string", email: "string" },
    board: { name: "string" },
  });
  expect(operation("query posts").responses[0]!.schema).toMatchObject({ type: "[Post!]!", items: { type: "Post!", ref: "Post" } });
  expect(operation("query posts").responses[0]!.example).toEqual([response!.example]);
  expect(operation("query version").responses[0]).toMatchObject({ schema: { type: "String!" }, example: "string" });
});

test("the query names the operation, takes a variable per argument (a value for each required one) and selects two levels of fields", () => {
  // comments needs an argument and oldTitle is deprecated: neither is selected.
  expect(operation("mutation createPost").query).toEqual({
    text: `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    id
    title
    status
    votes
    score
    createdAt
    author {
      id
      name
      email
    }
    board {
      name
    }
  }
}`,
    // Required input fields only.
    variables: { input: { title: "string", author: { email: "string" } } },
  });
  expect(operation("query posts").query).toMatchObject({
    text: expect.stringContaining("query Posts($filter: PostFilter, $first: Int, $after: ID) {\n  posts(filter: $filter, first: $first, after: $after) {\n"),
    // Optional arguments are left unset, so they take their defaults.
    variables: {},
  });
  expect(operation("mutation deletePost").query).toEqual({
    text: "mutation DeletePost($id: ID!, $at: DateTime) {\n  deletePost(id: $id, at: $at)\n}",
    variables: { id: "1" },
  });
  expect(operation("query version").query).toEqual({ text: "query Version {\n  version\n}", variables: {} });
});

test("every query is one the schema accepts, with a value for each variable it must have", () => {
  const schema = buildSchema(SDL);
  for (const one of doc.operations) {
    expect(validate(schema, parse(one.query!.text)), one.key).toEqual([]);
    for (const param of one.params) {
      if (param.schema.type.endsWith("!")) expect(one.query!.variables, one.key).toHaveProperty(param.name);
    }
  }
  // A non-null argument with a default is sent as its default.
  expect(operation("query recent").query!.variables).toEqual({ first: 5, status: "OPEN" });
});

test("a root type a field returns is named without a page to point at", () => {
  const payload = type("CreatePostPayload").schema;
  expect(property(payload, "query")).toEqual({ name: "query", required: true, type: "Query!" });
  const refs = new Set<string>();
  JSON.stringify(doc, (key, value) => (key === "ref" && refs.add(value as string), value as unknown));
  expect([...refs].filter((ref) => !doc.types.some((one) => one.name === ref))).toEqual([]);
});

test("a union or interface selects __typename, and a selection is never empty", () => {
  expect(operation("query search").query!.text).toBe(
    "query Search($text: String!) {\n  search(text: $text) {\n    __typename\n  }\n}",
  );
  expect(operation("query search").responses[0]!.example).toEqual([{ __typename: "Post" }]);
  expect(operation("query node").query!.text).toBe("query Node($id: ID!) {\n  node(id: $id) {\n    __typename\n    id\n  }\n}");
  // Viewer has no scalars, and its account has none either.
  expect(operation("query viewer").query!.text).toBe(
    "query Viewer {\n  viewer {\n    account {\n      __typename\n    }\n  }\n}",
  );
  expect(operation("query viewer").responses[0]!.example).toEqual({ account: { __typename: "Account" } });
});

test("types read as GraphQL writes them, with fields, enums, unions and interfaces", () => {
  const post = operation("query post").responses[0]!.schema!;
  expect(property(post, "title")).toEqual({ name: "title", required: true, type: "String!", description: "Its headline." });
  expect(property(post, "score")).toEqual({ name: "score", required: false, type: "Float" });
  expect(property(post, "status")).toEqual({ name: "status", required: true, type: "PostStatus!", ref: "PostStatus", enum: ["OPEN", "PLANNED", "DONE"] });
  expect(property(post, "oldTitle")).toMatchObject({ deprecated: true });
  expect(property(post, "comments")).toMatchObject({ type: "[Comment!]!", items: { type: "Comment!", ref: "Comment" } });
  expect(property(post, "createdAt")).toEqual({ name: "createdAt", required: true, type: "DateTime!", ref: "DateTime" });

  const input = operation("mutation createPost").params[0]!.schema;
  expect(input).toMatchObject({ type: "CreatePostInput!", ref: "CreatePostInput", description: "What a new post needs." });
  expect(input.properties!.map((one) => [one.name, one.required])).toEqual([
    ["title", true],
    ["body", false],
    ["status", false],
    ["tags", false],
    ["author", true],
  ]);
  expect(property(input, "status").default).toBe("OPEN");

  expect(type("SearchResult").schema.oneOf!.map((one) => one.ref)).toEqual(["Post", "User"]);
  expect(type("Node").schema).toMatchObject({ properties: [{ name: "id", type: "ID!" }] });
  expect(type("Node").schema.oneOf!.map((one) => one.ref)).toEqual(["User", "Post", "Comment"]);
});

test("a named type is spelled out two levels down, then only named", () => {
  // Viewer › Account › User are spelled out; what User's fields return is only named.
  const viewer = operation("query viewer").responses[0]!.schema!;
  const owner = property(property(viewer, "account"), "owner");
  expect(owner.properties!.map((one) => one.name)).toEqual(["id", "name", "email", "posts", "manager"]);
  expect(property(owner, "posts")).toEqual({ name: "posts", required: true, type: "[Post!]!", items: { type: "Post!", ref: "Post" } });
});

test("a type that contains itself is only named there", () => {
  const user = type("User").schema;
  expect(property(user, "manager")).toEqual({ name: "manager", required: false, type: "User", ref: "User" });
  // Post › author › posts comes back to Post.
  expect(property(property(type("Post").schema, "author"), "posts").items).toEqual({ type: "Post!", ref: "Post" });
  expect(property(type("PostFilter").schema, "and")).toEqual({
    name: "and",
    required: false,
    type: "[PostFilter!]",
    items: { type: "PostFilter!", ref: "PostFilter" },
  });
  expect(property(type("Comment").schema, "replies").items).toEqual({ type: "Comment!", ref: "Comment" });
});

test("types are every named type but the roots and the built-in ones", () => {
  expect(doc.types.map((one) => [one.name, one.kind, one.slug])).toEqual([
    ["Account", "object", "account"],
    ["AuthorInput", "input", "author-input"],
    ["Board", "object", "board"],
    ["Comment", "object", "comment"],
    ["CreatePostInput", "input", "create-post-input"],
    ["CreatePostPayload", "object", "create-post-payload"],
    ["DateTime", "scalar", "date-time"],
    ["Node", "interface", "node-2"],
    ["Post", "object", "post-2"],
    ["PostFilter", "input", "post-filter"],
    ["PostStatus", "enum", "post-status"],
    ["SearchResult", "union", "search-result"],
    ["User", "object", "user"],
    ["Viewer", "object", "viewer-2"],
  ]);
  expect(type("PostStatus").schema).toEqual({ type: "PostStatus", ref: "PostStatus", enum: ["OPEN", "PLANNED", "DONE"] });
  expect(type("DateTime").schema).toEqual({ type: "DateTime", ref: "DateTime" });
});

test("no two pages share a slug: the later gets a number, with a warning", () => {
  const slugs = [...doc.operations, ...doc.types].map((one) => one.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
  expect(doc.warnings.filter((warning) => warning.code === "DUPLICATE_SLUG").map((warning) => warning.where)).toEqual([
    "type Node",
    "type Post",
    "type Viewer",
  ]);
  // A number that's taken too is skipped.
  const taken = read("type Query { post: Post post_2: Int } type Post { id: ID }");
  expect([...taken.operations, ...taken.types].map((one) => one.slug)).toEqual(["post", "post-2", "post-3"]);
});

test("a field's arguments outside the roots are a warning", () => {
  expect(doc.warnings.filter((warning) => warning.code === "FIELD_ARGUMENTS").map((warning) => warning.where)).toEqual([
    "Post › comments",
    "User › posts",
  ]);
});

test("a schema using directives it doesn't declare is read", () => {
  expect(read('type Query { me: User } type User @key(fields: "id") { id: ID! }').operations).toHaveLength(1);
});

test("a federated service's file, which extends a Query it doesn't define, is read", () => {
  const federated = read('extend type Query { me: User } extend type Query { users: [User] } type User @key(fields: "id") { id: ID! }');
  expect(federated.operations.map((one) => one.key)).toEqual(["query me", "query users"]);
  expect(read("type Query { a: Int } extend type Query { b: Int }").operations).toHaveLength(2);
});

test("an input that takes exactly one field gets its first, and one that lists itself an empty list", () => {
  const odd = read(`
    input By @oneOf { not: By, id: ID, slug: String }
    input Filter { all: [Filter!]!, by: By! }
    type Query { find(filter: Filter!): Int }
  `);
  expect(odd.operations[0]!.query!.variables).toEqual({ filter: { all: [], by: { id: "1" } } });
});

test("a schema too large to spell out two levels down is spelled out fewer, with a warning", () => {
  // 30 types of 30 fields, each field another of the types: two levels down is 30 × 30 × 30 fields a type.
  const names = Array.from({ length: 30 }, (_, n) => `T${n}`);
  const large = read(
    `type Query { ${names.map((name) => `f${name}: ${name}`).join(" ")} }
    ${names.map((name) => `type ${name} { id: ID ${names.map((other) => `to${other}: ${other}`).join(" ")} }`).join("\n")}`,
  );
  expect(large.warnings.filter((warning) => warning.code === "TYPES_SHORTENED")).toHaveLength(1);
  expect(JSON.stringify(large).length).toBeLessThanOrEqual(5_000_000);
  // Two levels down from T0, a type is now only named (or the one before it is).
  const t0 = large.types.find((one) => one.name === "T0")!.schema;
  expect(property(t0, "toT1").properties?.find((one) => one.name === "toT2")?.properties).toBeUndefined();
  expect(doc.warnings.filter((warning) => warning.code === "TYPES_SHORTENED")).toEqual([]);
});

test("an enum's values count towards a doc's size, as the names they are", () => {
  const values = many(1_000, (n) => `V${n}`);
  // Spelled out at each of T's 1,000 fields, the enum is some 7 MB.
  const large = read(`type Query { t: T } type T { ${many(1_000, (n) => `f${n}: Big`)} } enum Big { ${values} }`);
  expect(large.warnings.filter((warning) => warning.code === "TYPES_SHORTENED")).toHaveLength(1);
  expect(JSON.stringify(large).length).toBeLessThanOrEqual(5_000_000);
  // A large enum many root fields return is well under it: read, and not shortened.
  const fits = read(`type Query { ${many(100, (n) => `r${n}: Big`)} } enum Big { ${values} }`);
  expect(fits.warnings).toEqual([]);
  expect(fits.operations[0]!.responses[0]!.schema!.enum).toHaveLength(1_000);
}, 30_000);

test("an input with nothing required gets its first field, as one read from an endpoint that takes exactly one needs", () => {
  const sdl = "input By @oneOf { id: ID, slug: String } type Query { find(by: By!): Int }";
  const answer = graphqlSync({ schema: buildSchema(sdl), source: GRAPHQL_INTROSPECTION_QUERY });
  expect(read(JSON.stringify(answer)).operations[0]!.query!.variables).toEqual({ by: { id: "1" } });
  expect(read("input Empty { _: Int = 1 } input None { all: [None!] } type Query { a(e: Empty!, n: None!): Int }").operations[0]!.query!.variables).toEqual({
    e: { _: 1 },
    n: { all: [] },
  });
});

test("an input that takes exactly one field skips a branch that can't be made", () => {
  const recursive = read(`
    input Choice @oneOf { next: Wrapper, id: ID }
    input Wrapper { choice: Choice! }
    type Query { pick(choice: Choice!): Int }
  `);
  expect(recursive.operations[0]!.query!.variables).toEqual({ choice: { id: "1" } });
});

test("an example is the caller's own: changing it leaves the next doc's alone", () => {
  const sdl = "scalar JSON type Query { settings(value: JSON!): JSON }";
  const first = read(sdl).operations[0]!;
  (first.query!.variables.value as Record<string, unknown>).changed = true;
  (first.responses[0]!.example as Record<string, unknown>).changed = true;
  const second = read(sdl).operations[0]!;
  expect(second.query!.variables).toEqual({ value: {} });
  expect(second.responses[0]!.example).toEqual({});
});

test.each([
  [
    "a wide union many root fields return",
    `type Query { ${many(700, (n) => `r${n}: Wide`)} } union Wide = ${Array.from({ length: 700 }, (_, n) => `M${n}`).join(" | ")} ${many(700, (n) => `type M${n} { id: ID }`)}`,
  ],
  [
    "a long description on a type many root fields return",
    `type Query { ${many(200, (n) => `r${n}: Described`)} } """${"words ".repeat(20_000)}""" type Described { id: ID }`,
  ],
  ["more root fields than a doc holds", `type Query { ${many(30_000, (n) => `r${n}: Int`)} }`],
  ["more arguments than a doc holds", `type Query { one(${many(60_000, (n) => `a${n}: Int`)}): Int }`],
  [
    "a long default on an input many root fields take",
    `type Query { ${many(200, (n) => `r${n}(a: Long): Int`)} } input Long { a: String = "${"x".repeat(50_000)}" }`,
  ],
  [
    "a deeply nested list many root fields return",
    `type Query { ${many(300, (n) => `r${n}: ${"[".repeat(500)}Int${"]".repeat(500)}`)} }`,
  ],
  [
    "a deeply nested list many root fields take",
    `type Query { ${many(300, (n) => `r${n}(a: ${"[".repeat(500)}Int${"]".repeat(500)}): Int`)} }`,
  ],
  [
    "a deeply nested list on a type many root fields return",
    `type Query { ${many(3_000, (n) => `r${n}: Deep`)} } type Deep { a: ${"[".repeat(500)}Int${"]".repeat(500)} }`,
  ],
])("%s is too large to show", (_name, sdl) => {
  expect(readGraphql(sdl)).toEqual({ error: expect.stringContaining("too large") });
  // Schemas this size take a second or two to parse: more on a busy machine.
}, 30_000);

test("a deeply nested list is given up before it's built", () => {
  // Spelled out, each of these is 250,000 characters of type text: all of them would be 75 million.
  const sdl = `type Query { ${many(300, (n) => `r${n}: ${"[".repeat(500)}Int${"]".repeat(500)}`)} }`;
  // A doc that's built is measured, so one never measured was given up on the way.
  const measured = vi.spyOn(JSON, "stringify");
  const result = readGraphql(sdl);
  const times = measured.mock.calls.length;
  measured.mockRestore();
  expect(result).toEqual({ error: expect.stringContaining("too large") });
  expect(times).toBe(0);
  // One such list alone is read.
  expect(read(`type Query { one: ${"[".repeat(50)}Int${"]".repeat(50)} }`).operations[0]!.responses[0]!.schema!.type).toHaveLength(103);
}, 30_000);

test("many names of one slug each get the next number, without trying the ones before it again", () => {
  const sdl = `type Query { ${many(500, (n) => `a${"_".repeat(n + 1)}: Int`)} }`;
  const looked = vi.spyOn(Set.prototype, "has");
  const result = readGraphql(sdl);
  const times = looked.mock.calls.length;
  looked.mockRestore();
  if ("error" in result) throw new Error(result.error);
  const slugs = result.doc.operations.map((one) => one.slug);
  expect(slugs.slice(0, 3)).toEqual(["a", "a-2", "a-3"]);
  expect(new Set(slugs).size).toBe(500);
  // Counting up from 2 for each of them is 125,000 looks.
  expect(times).toBeLessThan(10_000);
}, 30_000);

test("a doc is measured once built, whatever was reckoned on the way", () => {
  // A scalar's page is reckoned at nothing, and 100,000 of them come to more than a doc holds.
  const result = readGraphql(`type Query { ok: Boolean } ${many(100_000, (n) => `scalar S${n}`)}`);
  expect(result).toEqual({ error: expect.stringContaining("too large") });
}, 30_000);

test("a schema too large to show at all is an error", () => {
  const fields = Array.from({ length: 400 }, (_, n) => `f${n}: Int`).join(" ");
  const roots = Array.from({ length: 400 }, (_, n) => `r${n}: Big`).join(" ");
  expect(readGraphql(`type Query { ${roots} } type Big { ${fields} }`)).toEqual({ error: expect.stringContaining("too large") });
});

test.each([
  ["nothing", "", "empty"],
  ["spaces", "  \n ", "empty"],
  ["prose", "Hello, this is our API.", "isn't a GraphQL schema file"],
  ["a query, not a schema", "query { posts { id } }", "no queries"],
  ["types without a root", "type Post { id: ID }", "no queries"],
  ["a type that isn't defined", "type Query { post: Post }", "Unknown type"],
  ["broken JSON", '{ "data": ', "isn't valid JSON"],
  ["JSON that isn't an introspection result", '{ "openapi": "3.1.0" }', "no __schema"],
  ["JSON null data", '{ "data": null }', "no __schema"],
  ["an endpoint's refusal", '{ "errors": [{ "message": "Introspection is disabled" }] }', "Introspection is disabled"],
  ["an introspection result without types", '{ "__schema": {} }', "couldn't be read"],
  ["an introspection result of the wrong shape", '{ "__schema": { "types": [{ "kind": "OBJECT", "name": "Query", "fields": 3 }], "queryType": { "name": "Query" } } }', "couldn't be read"],
  ["a type whose field has no type", '{ "__schema": { "types": [{ "kind": "OBJECT", "name": "Query", "fields": [{ "name": "a", "args": [] }], "interfaces": [] }], "queryType": { "name": "Query" } } }', "couldn't be read"],
  ["a type nested too deeply", `type Query { a: ${"[".repeat(50_000)}Int${"]".repeat(50_000)} }`, ""],
  ["over 5 MB", `type Query { ok: Boolean }${" ".repeat(5 * 1024 * 1024)}`, "over 5 MB"],
  ["not text", 42 as unknown as string, "empty"],
  ["not text at all", null as unknown as string, "empty"],
])("%s is an error, never a throw", (_name, text, expected) => {
  const result = readGraphql(text);
  expect(result).toEqual({ error: expect.stringContaining(expected) });
});

test("a syntax error says where", () => {
  expect(readGraphql("type Query {\n  posts: [Post\n}")).toEqual({ error: expect.stringMatching(/\(line 3, column 1\)$/) });
});

test("a scalar named as something every object has is read like any other", () => {
  const result = readGraphql("scalar constructor scalar toString type Query { made(by: constructor!): toString }");
  if ("error" in result) throw new Error(result.error);
  expect(result.doc.operations[0]?.query?.variables).toEqual({ by: "string" });
});
