import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { type OpenApiBounds, readOpenApi } from "./openapi";
import type { ApiDoc, ApiSchema } from "./types";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, more: object = {}) => ({ content: { "application/json": { schema, ...more } } });

/** A feedback tool's API: the size and habits of a spec a team would upload. */
const fixture = {
  openapi: "3.1.0",
  info: { title: "Acme Feedback API", version: "2026-11-01", description: "Posts, comments and **votes**." },
  servers: [
    { url: "https://api.acme.example/v1", description: "Production" },
    { url: "https://{region}.acme.example/v1", variables: { region: { default: "eu", enum: ["eu", "us"], description: "Where the data is." }, odd: 5 } },
  ],
  tags: [
    { name: "Posts", description: "Ideas and bugs people send." },
    { name: "Comments" },
    { name: "Unused", description: "No operation has it." },
  ],
  security: [{ bearer: [] }],
  paths: {
    "/posts": {
      get: {
        tags: ["Posts"],
        summary: "List posts",
        operationId: "listPosts",
        parameters: [
          { name: "status", in: "query", description: "Only posts in this status.", schema: ref("Status") },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }, example: 50 },
          { $ref: "#/components/parameters/Cursor" },
        ],
        responses: {
          "200": json({ type: "object", required: ["data"], properties: { data: { type: "array", items: ref("Post") }, next: { type: ["string", "null"] } } }),
          default: { $ref: "#/components/responses/Error" },
        },
      },
      post: {
        tags: ["Posts", "Comments"],
        summary: "Create a post",
        description: "Adds a post to a board.",
        security: [{ bearer: [] }, { apiKey: [], workspace: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": { schema: { type: "object" } },
            "application/json": { schema: ref("NewPost"), examples: { bug: { value: { title: "Export fails", board: "bugs" } } } },
          },
        },
        responses: {
          "201": { description: "The post.", ...json(ref("Post")) },
          "400 - Bad Request": { $ref: "#/components/responses/Error" },
          "422": { description: "Not valid.", ...json(ref("Error"), { example: { message: "title is required" } }) },
        },
      },
    },
    "/posts/{number}": {
      parameters: [
        { name: "number", in: "path", required: true, description: "The path's.", schema: { type: "integer" } },
        { name: "X-Trace", in: "header", schema: { type: "string" } },
      ],
      get: {
        tags: ["Posts"],
        operationId: "posts_get",
        parameters: [{ name: "number", in: "path", required: true, description: "The post's number.", schema: { type: "integer", minimum: 1 } }],
        responses: { "200": json(ref("Post")), "404": { description: "No such post." } },
      },
      delete: {
        tags: ["Posts"],
        summary: "Delete a post",
        deprecated: true,
        servers: [{ url: "https://admin.acme.example" }],
        responses: { "204": { description: "Gone." } },
      },
    },
    "/posts/{number}/comments": {
      get: {
        tags: ["Comments"],
        summary: "List comments",
        parameters: [{ name: "number", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": json({ type: "array", items: ref("Comment") }) },
      },
      post: {
        tags: ["Comments"],
        summary: "List comments",
        parameters: [{ name: "number", in: "path", required: true, schema: { type: "integer" } }],
        requestBody: json({ type: "object", required: ["body"], properties: { body: { type: "string", minLength: 1, maxLength: 5000 } } }),
        responses: { "201": json(ref("Comment")) },
      },
    },
    "/health": {
      get: { security: [], responses: { "200": { description: "Up.", content: { "text/plain": { schema: { type: "string" } } } } } },
    },
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "A project's API key." },
      apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
      workspace: { type: "apiKey", in: "query", name: "workspace" },
    },
    parameters: { Cursor: { name: "cursor", in: "query", description: "Where the last page ended.", schema: { type: "string" } } },
    responses: { Error: { description: "What went wrong.", ...json(ref("Error")) } },
    schemas: {
      Status: { type: "string", enum: ["open", "planned", "done"], default: "open" },
      User: {
        type: "object",
        required: ["id", "email"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email", example: "e2e-ada@example.com" },
          team: ref("Team"),
        },
      },
      Team: { type: "object", properties: { name: { type: "string" }, owner: ref("Account") } },
      Account: { type: "object", properties: { plan: { type: "string" } } },
      Post: {
        type: "object",
        description: "An idea or a bug.",
        required: ["number", "title", "status"],
        properties: {
          number: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 3, maxLength: 200 },
          status: ref("Status"),
          author: { anyOf: [ref("User"), { type: "null" }] },
          tags: { type: "array", items: { type: "string" }, maxItems: 10, uniqueItems: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      NewPost: {
        allOf: [
          { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 3, maxLength: 200 }, body: { type: "string" } } },
          { type: "object", required: ["board"], properties: { board: { type: "string", pattern: "^[a-z-]+$" } } },
        ],
      },
      Comment: {
        type: "object",
        required: ["id", "body"],
        properties: { id: { type: "string" }, body: { type: "string" }, author: ref("User"), replies: { type: "array", items: ref("Comment") } },
      },
      Error: { type: "object", required: ["message"], properties: { message: { type: "string" }, code: { type: "integer" } } },
    },
  },
};

function read(text: string): ApiDoc {
  const result = readOpenApi(text);
  if ("error" in result) throw new Error(result.error);
  return result.doc;
}
/** A small spec around the parts a test is about. */
const spec = (parts: object): ApiDoc => read(JSON.stringify({ openapi: "3.0.3", info: { title: "T", version: "1" }, ...parts }));
/** The error a text is refused with, if it is. Tests of a limit pass a small one, so a small file crosses it. */
const errorOf = (text: string, bounds?: OpenApiBounds) => {
  const result = readOpenApi(text, bounds);
  return "error" in result ? result.error : null;
};
/** One schema, read as `GET /x`'s 200 response. */
function schemaOf(schema: unknown, schemas: object = {}): { schema: ApiSchema; example: unknown; doc: ApiDoc } {
  const doc = spec({ paths: { "/x": { get: { summary: "X", responses: { "200": json(schema) } } } }, components: { schemas } });
  const response = doc.operations[0]!.responses[0]!;
  return { schema: response.schema!, example: response.example, doc };
}
const operation = (doc: ApiDoc, key: string) => doc.operations.find((one) => one.key === key)!;
const codes = (doc: ApiDoc) => doc.warnings.map((warning) => `${warning.code} @ ${warning.where}`);

test("a spec reads the same from JSON and from YAML", () => {
  const doc = read(JSON.stringify(fixture));
  expect(read(stringify(fixture))).toEqual(doc);
  expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);

  expect(doc).toMatchObject({ format: "openapi", title: "Acme Feedback API", version: "2026-11-01", description: "Posts, comments and **votes**." });
  expect(doc.servers).toEqual([
    { url: "https://api.acme.example/v1", description: "Production" },
    { url: "https://{region}.acme.example/v1", description: "", variables: { region: { default: "eu", enum: ["eu", "us"], description: "Where the data is." } } },
  ]);
  expect(doc.auth).toEqual([
    { key: "bearer", kind: "bearer", name: "Authorization", description: "A project's API key." },
    { key: "apiKey", kind: "header", name: "X-Api-Key", description: "" },
    { key: "workspace", kind: "query", name: "workspace", description: "" },
  ]);
  expect(doc.operations.map((one) => [one.key, one.title, one.slug, one.group])).toEqual([
    ["GET /posts", "List posts", "list-posts", "Posts"],
    ["POST /posts", "Create a post", "create-a-post", "Posts"],
    ["GET /posts/{}", "Posts get", "posts-get", "Posts"],
    ["DELETE /posts/{}", "Delete a post", "delete-a-post", "Posts"],
    ["GET /posts/{}/comments", "List comments", "list-comments", "Comments"],
    ["POST /posts/{}/comments", "List comments", "list-comments-2", "Comments"],
    ["GET /health", "GET /health", "get-health", "Other"],
  ]);
  expect(doc.types.map((type) => [type.name, type.slug, type.kind])).toEqual([
    ["Status", "status", "enum"],
    ["User", "user", "object"],
    ["Team", "team", "object"],
    ["Account", "account", "object"],
    ["Post", "post", "object"],
    ["NewPost", "newpost", "object"],
    ["Comment", "comment", "object"],
    ["Error", "error", "object"],
  ]);
  expect(codes(doc)).toEqual([
    "STATUS_GUESSED @ POST /posts › responses › 400 - Bad Request",
    "DUPLICATE_SLUG @ POST /posts/{number}/comments",
    "NO_TITLE @ GET /health",
  ]);
});

test("a YAML spec with comments and anchors", () => {
  const doc = read(`
openapi: 3.0.3   # the version
info: { title: Tiny, version: 1.0 }
paths:
  /pets:
    get:
      summary: List pets
      responses:
        200: &ok
          description: Fine
        201: *ok
`);
  // The version as the spec's text has it, not the number YAML reads.
  expect(doc.version).toBe("1.0");
  expect(read("openapi: 3.0.3\ninfo: { title: T, version: 1.10 }").version).toBe("1.10");
  expect(read("openapi: 3.0.3\ninfo:\n  version: 2 # second\n").version).toBe("2");
  expect(read('openapi: 3.0.3\ninfo: { version: "1.0.0" }').version).toBe("1.0.0");
  expect(read('{"openapi": "3.0.3", "info": {"version": 1.5}}').version).toBe("1.5");
  expect(read("openapi: 3.0.3\ninfo:\n  version:\n").version).toBeNull();
  expect(read('{"openapi": "3.0.3", "info": {"version": {"major": 1}}}').version).toBeNull();
  expect(doc.operations[0]!.responses).toEqual([
    { status: "200", description: "Fine", contentType: null, schema: null },
    { status: "201", description: "Fine", contentType: null, schema: null },
  ]);
});

test("YAML merge keys are read", () => {
  const doc = read(`
openapi: 3.0.3
info: { title: Merged, version: "1" }
paths:
  /posts:
    get:
      summary: List posts
      responses:
        "200": &ok
          description: Fine
          content: { application/json: { schema: { $ref: "#/components/schemas/Post" } } }
        "201":
          <<: *ok
          description: Made
components:
  schemas:
    Base: &base
      type: object
      properties: { id: { type: string } }
    Post:
      <<: *base
      description: A post
`);
  expect(doc.types[1]).toEqual({ name: "Post", slug: "post", kind: "object", schema: { type: "object", ref: "Post", description: "A post", properties: [{ name: "id", required: false, type: "string" }] } });
  expect(doc.operations[0]!.responses.map((response) => [response.status, response.description, response.schema?.type, response.example])).toEqual([
    ["200", "Fine", "Post", { id: "string" }],
    ["201", "Made", "Post", { id: "string" }],
  ]);
});

test("text that isn't a spec is an error to act on", () => {
  expect(errorOf("")).toBe("This file is empty.");
  expect(errorOf("  \n")).toBe("This file is empty.");
  expect(errorOf("hello")).toMatch(/isn't an OpenAPI spec/);
  expect(errorOf("[1, 2]")).toMatch(/isn't an OpenAPI spec/);
  expect(errorOf("null")).toMatch(/isn't an OpenAPI spec/);
  expect(errorOf('{"paths": {}}')).toMatch(/isn't an OpenAPI spec/);
  expect(errorOf('{"swagger": "2.0", "paths": {}}')).toMatch(/Swagger 2/);
  expect(errorOf("openapi: 3\n")).toBeNull();
  expect(errorOf("openapi: 3.0\npaths: {}")).toBeNull();
  expect(errorOf('{"openapi": 3.1}')).toBeNull();
  expect(errorOf('{"openapi": "30.0"}')).toMatch(/says it's OpenAPI 30.0/);
  expect(errorOf('{"openapi": "4.0.0"}')).toBe("This spec says it's OpenAPI 4.0.0. An API reference reads OpenAPI 3.0 and 3.1.");
  expect(errorOf("a: [1, 2")).toMatch(/^This file isn't valid JSON or YAML: /);
  // A key written twice is read as JSON reads it: the last one counts.
  expect(errorOf("openapi: 4.0.0\nopenapi: 3.0.0\n")).toBeNull();
  expect(errorOf('{"openapi": "4.0.0", "openapi": "3.0.0"}')).toBeNull();
  // The version's text is the last one's too.
  expect(read("openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0\n  version: 2.10\n").version).toBe("2.10");
  expect(read("openapi: 3.0.0\ninfo: { version: 1.0 }\ninfo: { version: 3.10 }\n").version).toBe("3.10");
  expect(errorOf(`{"openapi": "3.0.0", "x": "${"a".repeat(5 * 1024 * 1024)}"}`)).toMatch(/over 5 MB/);
  expect(errorOf(`{"openapi": "3.0.0", "x": "${"é".repeat(3 * 1024 * 1024)}"}`)).toMatch(/over 5 MB/);
});

test("it never throws, and a spec's keys never reach Object's prototype", () => {
  const deep = (open: string, close: string, levels: number) => open.repeat(levels) + close.repeat(levels);
  const odd = [
    "﻿",
    "0",
    "true",
    '"openapi"',
    "- openapi: 3.0.0",
    "openapi: 3.0.0",
    "openapi: 3.1.0\npaths: 5\ncomponents: []\ntags: x\nservers: {}\nsecurity: 1\ninfo: []",
    '{"openapi": "3.0.0", "paths": {"/a": {"get": {"parameters": 1, "responses": [], "requestBody": "x", "tags": {}, "security": {}}}, "/b": null, "/c": {"get": null}}}',
    '{"openapi": "3.0.0", "paths": {"/a": {"get": {"parameters": [null, 1, {}], "requestBody": {"content": {"a/b": null}}, "responses": {"200": {"content": {"a/b": 1}}}}}}}',
    `{"openapi": "3.0.0", "x": ${deep("[", "]", 100_000)}}`,
    `{"openapi": "3.0.0", "paths": {"/a": {"get": {"responses": {"200": {"content": {"a/b": {"schema": ${deep('{"items":', "}", 20_000)}}}}}}}}}`,
    `openapi: 3.0.0\nx: ${deep("[", "]", 50_000)}`,
    "openapi: 3.0.0\na: &a [*a]",
    "openapi: 3.0.0\na: &a\n  b: *a",
    `openapi: 3.0.0\na: &a [x, x, x, x, x, x, x, x, x]\n${"bcdefghi".split("").map((key, index) => `${key}: &${key} [${`*${"abcdefgh"[index]}, `.repeat(9)}]`).join("\n")}`,
    '{"openapi": "3.0.0", "__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 1}}, "paths": {"__proto__": {"get": {}}, "/a": {"__proto__": {"polluted": 1}, "get": {"responses": {"__proto__": {}, "constructor": {}, "200": {"content": {"__proto__": {"polluted": 1}}}}}}}}',
    "openapi: 3.0.0\n__proto__: { polluted: 1 }\npaths: { /a: { get: { __proto__: { polluted: 1 }, tags: [__proto__, constructor] } } }",
    42 as unknown as string,
    undefined as unknown as string,
  ];
  for (const text of odd) {
    const result = readOpenApi(text);
    expect("error" in result ? typeof result.error : typeof result.doc).toMatch(/string|object/);
    if ("error" in result) expect(result.error).not.toBe("");
  }
  expect(({} as { polluted?: number }).polluted).toBeUndefined();

  // Names from Object's prototype are ordinary names in a spec.
  const { schema, example, doc } = schemaOf(
    { type: "object", properties: { ["__proto__"]: { type: "string" }, constructor: ref("constructor"), toString: { $ref: "#/components/schemas/__proto__" }, missing: ref("hasOwnProperty") } },
    { constructor: { type: "integer" }, ["__proto__"]: { type: "boolean" } },
  );
  expect(schema.properties!.map((property) => [property.name, property.type])).toEqual([
    ["__proto__", "string"],
    ["constructor", "constructor"],
    ["toString", "__proto__"],
    ["missing", "object"],
  ]);
  expect(Object.entries(example as object)).toEqual([
    ["__proto__", "string"],
    ["constructor", 0],
    ["toString", true],
    ["missing", {}],
  ]);
  expect(Object.getPrototypeOf(example)).toBe(Object.prototype);
  expect(doc.types.map((type) => type.name)).toEqual(["constructor", "__proto__"]);
  expect(codes(doc)).toEqual(["UNKNOWN_REF @ GET /x › responses › 200 › missing"]);
  expect(({} as { polluted?: number }).polluted).toBeUndefined();
});

test("only references inside the spec are followed, and a cycle of them ends", () => {
  const { schema, doc } = schemaOf(
    {
      type: "object",
      properties: {
        file: { $ref: "./other.yaml#/Thing" },
        web: { $ref: "https://example.com/schema.json" },
        gone: ref("Gone"),
        whole: { $ref: "#" },
        self: ref("Self"),
        ping: ref("Ping"),
        alias: ref("Alias"),
        inner: { $ref: "#/components/schemas/Named/properties/a~1b" },
      },
    },
    {
      Self: { $ref: "#/components/schemas/Self" },
      Ping: { $ref: "#/components/schemas/Pong" },
      Pong: { $ref: "#/components/schemas/Ping" },
      Alias: { $ref: "#/components/schemas/Named", description: "Named, by another name." },
      Named: { type: "object", description: "A thing.", properties: { "a/b": { type: "integer" } } },
    },
  );
  const fields = Object.fromEntries(schema.properties!.map(({ name, required, ...rest }) => [name, rest]));
  expect(fields).toEqual({
    file: { type: "object" },
    web: { type: "object" },
    gone: { type: "object" },
    whole: { type: "object" },
    self: { type: "Self", ref: "Self" },
    ping: { type: "Ping", ref: "Ping" },
    alias: { type: "Alias", ref: "Alias", description: "Named, by another name.", properties: [{ name: "a/b", required: false, type: "integer" }] },
    inner: { type: "integer" },
  });
  expect(codes(doc)).toEqual([
    "OUTSIDE_REF @ GET /x › responses › 200 › file",
    "OUTSIDE_REF @ GET /x › responses › 200 › web",
    "UNKNOWN_REF @ GET /x › responses › 200 › gone",
    "UNKNOWN_REF @ GET /x › responses › 200 › whole",
  ]);
  for (const warning of doc.warnings) expect(warning.message).toBe(doc.warnings.find((one) => one.code === warning.code)!.message);

  // Parameters, bodies, responses and path items too: a broken one is left out.
  const broken = spec({
    paths: {
      "/a": { get: { summary: "A", parameters: [{ $ref: "#/components/parameters/Gone" }], requestBody: { $ref: "x.yaml" }, responses: { "200": { $ref: "#/nowhere" } } } },
      "/b": { $ref: "#/components/pathItems/B" },
      "/c": { $ref: "#/paths/~1c" },
    },
    components: { pathItems: { B: { get: { summary: "B", responses: {} } } }, schemas: { Loop: { allOf: [ref("Loop"), { properties: { a: { type: "string" } } }] } } },
  });
  expect(broken.operations.map((one) => [one.key, one.params, one.body, one.responses])).toEqual([
    ["GET /a", [], null, []],
    ["GET /b", [], null, []],
  ]);
  expect(codes(broken)).toEqual([
    "UNKNOWN_REF @ GET /a › parameters › 1",
    "OUTSIDE_REF @ GET /a › body",
    "UNKNOWN_REF @ GET /a › responses › 200",
    "UNKNOWN_REF @ /c",
  ]);
  expect(broken.types[0]!.schema).toEqual({ type: "object", ref: "Loop", properties: [{ name: "a", required: false, type: "string" }] });
});

test("groups are the spec's tags, then the tags only operations name, then Other", () => {
  const get = (tags?: unknown) => ({ get: { summary: "S", tags, responses: {} } });
  const doc = spec({
    tags: [{ name: "Billing", description: "Money." }, { name: "Empty" }, { name: "Users", description: "People." }, { name: "Billing", description: "Again." }, "odd"],
    paths: { "/a": get(["Late", "Users"]), "/b": get(["Users"]), "/c": get(), "/d": get(["Billing"]), "/e": get(["billing"]), "/f": get([]), "/g": get([7, ""]), "/h": get(["Users", "Second", "Users", "Billing"]) },
  });
  expect(doc.groups).toEqual([
    { key: "Billing", name: "Billing", description: "Money." },
    { key: "Users", name: "Users", description: "People." },
    { key: "Late", name: "Late", description: "" },
    { key: "billing", name: "billing", description: "" },
    { key: "Second", name: "Second", description: "" },
    { key: "Other", name: "Other", description: "" },
  ]);
  expect(doc.operations.map((one) => one.group)).toEqual(["Late", "Users", "Other", "Billing", "billing", "Other", "Other", "Users"]);
  // Its first tag is where it's listed; the others are kept beside it.
  expect(doc.operations.map((one) => one.alsoIn)).toEqual([["Users"], undefined, undefined, undefined, undefined, undefined, undefined, ["Second", "Billing"]]);
  expect(doc.operations[1]).not.toHaveProperty("alsoIn");

  // A tag named "Other" is where untagged operations go, in its own place.
  const other = spec({ tags: [{ name: "Other", description: "The rest." }, { name: "Users" }], paths: { "/a": get(["Users"]), "/b": get() } });
  expect(other.groups).toEqual([
    { key: "Other", name: "Other", description: "The rest." },
    { key: "Users", name: "Users", description: "" },
  ]);
});

test("an operation's key, title and slug", () => {
  const responses = {};
  const doc = spec({
    paths: {
      "/users/{id}": { get: { summary: "  Get a user ", operationId: "getUser", responses }, put: { operationId: "users.updateOne", responses }, patch: { responses } },
      "/users/{userId}": { get: { summary: "The same path", responses }, delete: { summary: "Get a user", responses } },
      "/users/{id}/keys/{key}": { post: { summary: "Größe ändern!", responses }, head: { summary: "日本語", responses }, options: { operationId: "日本語", responses } },
      "x-internal": { get: { responses } },
    },
    components: { schemas: { "Get a user": { type: "string" }, Money: { type: "integer" }, money: { type: "integer" } } },
  });
  expect(doc.operations.map((one) => [one.key, one.path, one.kind, one.title, one.slug])).toEqual([
    ["GET /users/{id}", "/users/{id}", "GET", "Get a user", "get-a-user"],
    ["PUT /users/{}", "/users/{id}", "PUT", "Users update one", "users-update-one"],
    ["PATCH /users/{}", "/users/{id}", "PATCH", "PATCH /users/{id}", "patch-users-id"],
    ["GET /users/{userId}", "/users/{userId}", "GET", "The same path", "the-same-path"],
    ["DELETE /users/{}", "/users/{userId}", "DELETE", "Get a user", "get-a-user-2"],
    ["POST /users/{}/keys/{}", "/users/{id}/keys/{key}", "POST", "Größe ändern!", "gro-e-andern"],
    ["HEAD /users/{}/keys/{}", "/users/{id}/keys/{key}", "HEAD", "日本語", "head-users-id-keys-key"],
    ["OPTIONS /users/{}/keys/{}", "/users/{id}/keys/{key}", "OPTIONS", "OPTIONS /users/{id}/keys/{key}", "options-users-id-keys-key"],
  ]);
  expect(doc.types.map((type) => type.slug)).toEqual(["get-a-user-3", "money", "money-2"]);
  expect(codes(doc)).toEqual([
    "DUPLICATE_OPERATION @ GET /users/{id}",
    "NO_TITLE @ PATCH /users/{id}",
    "DUPLICATE_OPERATION @ GET /users/{userId}",
    "DUPLICATE_SLUG @ DELETE /users/{userId}",
    "DUPLICATE_SLUG @ schemas › Get a user",
    "DUPLICATE_SLUG @ schemas › money",
  ]);
});

test("operations that would share a key each keep their parameters' names, whatever their order", () => {
  const get = { get: { summary: "S", responses: {} } };
  const post = { post: { summary: "S", responses: {} } };
  const keys = (paths: object) => spec({ paths }).operations.map((one) => one.key).sort();
  const expected = ["GET /users/{id}", "GET /users/{userId}", "POST /users/{}"];
  expect(keys({ "/users/{id}": { ...get, ...post }, "/users/{userId}": get })).toEqual(expected);
  expect(keys({ "/users/{userId}": get, "/users/{id}": { ...get, ...post } })).toEqual(expected);
  expect(codes(spec({ paths: { "/users/{userId}": get, "/users/{id}": get } }))).toEqual([
    "DUPLICATE_OPERATION @ GET /users/{userId}",
    "DUPLICATE_OPERATION @ GET /users/{id}",
    "DUPLICATE_SLUG @ GET /users/{id}",
  ]);
  // Never shared, even by a path that is another's key.
  expect(keys({ "/a/{id}": get, "/a/{}": get, "/a/{x}": get })).toEqual(["GET /a/{id}", "GET /a/{x}", "GET /a/{}"]);
});

test("thousands of operations with one title each get the next number", () => {
  const paths = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`/${index}`, { get: { summary: "Same" }, post: { summary: "Same 2" } }]));
  const doc = spec({ paths, components: { schemas: { same: {}, _: {}, __: {} } } });
  const slugs = [...doc.operations, ...doc.types].map((one) => one.slug);
  expect(new Set(slugs).size).toBe(40_003);
  expect(slugs.slice(0, 6)).toEqual(["same", "same-2", "same-3", "same-2-2", "same-4", "same-2-3"]);
  expect(slugs.slice(-3)).toEqual(["same-20002", "type", "type-2"]);
});

test("parameters: the path's and the operation's, the operation's winning", () => {
  const doc = read(JSON.stringify(fixture));
  expect(operation(doc, "GET /posts/{}").params).toEqual([
    { name: "number", in: "path", required: true, description: "The post's number.", schema: { type: "integer", constraints: "at least 1" } },
    { name: "X-Trace", in: "header", required: false, description: "", schema: { type: "string" } },
  ]);
  expect(operation(doc, "GET /posts").params).toEqual([
    {
      name: "status",
      in: "query",
      required: false,
      description: "Only posts in this status.",
      schema: { type: "Status", ref: "Status", enum: ["open", "planned", "done"], default: "open" },
    },
    { name: "limit", in: "query", required: false, description: "", schema: { type: "integer", constraints: "1–100", default: 20 }, example: 50 },
    { name: "cursor", in: "query", required: false, description: "Where the last page ended.", schema: { type: "string" } },
  ]);

  const odd = spec({
    paths: {
      "/a/{id}": {
        get: {
          summary: "A",
          parameters: [
            { name: "id", in: "path", schema: { type: "string" } },
            { name: "id", in: "query", deprecated: true, schema: { type: "string", example: "from-schema" } },
            { name: "filter", in: "query", required: true, content: { "application/json": { schema: { type: "object" } } }, examples: { one: { value: { a: 1 } } } },
            { in: "query" },
            { name: "body", in: "body" },
          ],
          responses: {},
        },
      },
    },
  });
  expect(odd.operations[0]!.params).toEqual([
    { name: "id", in: "path", required: true, description: "", schema: { type: "string" } },
    { name: "id", in: "query", required: false, description: "", schema: { type: "string", deprecated: true }, example: "from-schema" },
    { name: "filter", in: "query", required: true, description: "", schema: { type: "object" }, example: { a: 1 } },
  ]);
  expect(codes(odd)).toEqual(["INVALID_PARAMETER @ GET /a/{id} › parameters › 4", "INVALID_PARAMETER @ GET /a/{id} › parameters › body"]);
});

test("a parameter's example is its own, its content's, or its schema's, written either way", () => {
  const doc = spec({
    openapi: "3.1.0",
    paths: {
      "/a": {
        get: {
          summary: "A",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", examples: [20, 50] } },
            { name: "page", in: "query", schema: { type: "integer", example: 2, examples: [3] } },
            { name: "own", in: "query", example: 7, schema: { type: "integer", examples: [20] } },
            { name: "none", in: "query", schema: { type: "integer", examples: [] } },
          ],
          responses: {},
        },
      },
    },
  });
  expect(doc.operations[0]!.params.map((param) => [param.name, param.example])).toEqual([
    ["limit", 20],
    ["page", 2],
    ["own", 7],
    ["none", undefined],
  ]);
});

test("a path's own operations beside its $ref are read with the ones it points at", () => {
  const doc = spec({
    paths: {
      "/a": { $ref: "#/components/pathItems/Shared", post: { summary: "Create", responses: {} }, parameters: [{ name: "own", in: "query" }] },
      "/b": { $ref: "#/components/pathItems/Shared" },
      "/c": { $ref: "#/components/pathItems/Gone", get: { summary: "Still here", responses: {} } },
    },
    components: { pathItems: { Shared: { get: { summary: "List", responses: {} }, post: { summary: "Shared create", responses: {} }, parameters: [{ name: "shared", in: "query" }] } } },
  });
  expect(doc.operations.map((one) => [one.key, one.title, one.params.map((param) => param.name)])).toEqual([
    ["GET /a", "List", ["own"]],
    ["POST /a", "Create", ["own"]],
    ["GET /b", "List", ["shared"]],
    ["POST /b", "Shared create", ["shared"]],
    ["GET /c", "Still here", []],
  ]);
  expect(codes(doc)).toEqual(["DUPLICATE_SLUG @ GET /b", "UNKNOWN_REF @ /c"]);
});

test("an object that only lists its choices is one of them", () => {
  const { schema, example, doc } = schemaOf(ref("Pet"), {
    Cat: { type: "object", properties: { lives: { type: "integer" } } },
    Dog: { type: "object", properties: { barks: { type: "boolean" } } },
    Pet: { type: "object", oneOf: [ref("Cat"), ref("Dog")], discriminator: { propertyName: "kind" } },
    // With fields of its own it's an object that also has choices.
    Tagged: { type: "object", properties: { kind: { type: "string" } }, oneOf: [ref("Cat"), ref("Dog")] },
  });
  expect(schema).toMatchObject({ type: "Pet", ref: "Pet", oneOf: [{ type: "Cat" }, { type: "Dog" }] });
  expect(example).toEqual({ lives: 0 });
  expect(doc.types.map((type) => [type.name, type.kind, type.schema.type])).toEqual([
    ["Cat", "object", "object"],
    ["Dog", "object", "object"],
    ["Pet", "union", "Cat or Dog"],
    ["Tagged", "object", "object"],
  ]);

  // The usual layout: each subtype folds the base in, and the base lists the subtypes.
  const back = schemaOf(ref("Pet"), {
    Pet: { type: "object", discriminator: { propertyName: "kind" }, oneOf: [ref("Cat"), ref("Dog")] },
    Cat: { allOf: [ref("Pet"), { properties: { lives: { type: "integer" }, friend: ref("Pet") } }] },
    Dog: { allOf: [ref("Pet"), { properties: { barks: { type: "boolean" } } }] },
  });
  expect(back.example).toEqual({ lives: 0, friend: {} });
  // Each subtype is spelled out under the base, with its own fields, and the base inside it is only named.
  expect(back.schema).toEqual({
    type: "Pet",
    ref: "Pet",
    oneOf: [
      {
        type: "Cat",
        ref: "Cat",
        properties: [
          { name: "lives", required: false, type: "integer" },
          { name: "friend", required: false, type: "Pet", ref: "Pet" },
        ],
      },
      { type: "Dog", ref: "Dog", properties: [{ name: "barks", required: false, type: "boolean" }] },
    ],
  });
  // A subtype isn't "one of" its base's subtypes: its own page has its fields, and the base it refers to its choices.
  const cat = back.doc.types[1]!.schema;
  expect(cat).not.toHaveProperty("oneOf");
  expect(cat.properties!.map((property) => property.name)).toEqual(["lives", "friend"]);
  expect(cat.properties![1]).toMatchObject({ type: "Pet", ref: "Pet", oneOf: [{ type: "Cat", ref: "Cat" }, { type: "Dog", ref: "Dog" }] });
  expect(back.doc.warnings).toEqual([]);
  expect(back.doc.types.map((type) => [type.name, type.kind])).toEqual([
    ["Pet", "union"],
    ["Cat", "object"],
    ["Dog", "object"],
  ]);

  // The same with no `type` on the base, and with words beside each choice's reference, in 3.0's way and 3.1's.
  const worded = (openapi: string, choice: (name: string, description: string) => object) =>
    read(
      JSON.stringify({
        openapi,
        paths: { "/x": { get: { summary: "X", responses: { "200": json(ref("Pet")) } } } },
        components: {
          schemas: {
            Pet: { discriminator: { propertyName: "kind" }, oneOf: [choice("Cat", "A cat."), choice("Dog", "A dog.")] },
            Cat: { allOf: [ref("Pet"), { properties: { lives: { type: "integer" } } }] },
            Dog: { allOf: [ref("Pet"), { properties: { barks: { type: "boolean" } } }] },
          },
        },
      }),
    );
  for (const doc of [
    worded("3.0.3", (name, description) => ({ allOf: [ref(name)], description })),
    worded("3.1.0", (name, description) => ({ $ref: `#/components/schemas/${name}`, description })),
  ]) {
    const response = doc.operations[0]!.responses[0]!;
    expect(response.schema).toEqual({
      type: "Pet",
      ref: "Pet",
      oneOf: [
        { type: "Cat", ref: "Cat", description: "A cat.", properties: [{ name: "lives", required: false, type: "integer" }] },
        { type: "Dog", ref: "Dog", description: "A dog.", properties: [{ name: "barks", required: false, type: "boolean" }] },
      ],
    });
    expect(response.example).toEqual({ lives: 0 });
    expect(doc.types[1]!.schema).toEqual({ type: "object", ref: "Cat", properties: [{ name: "lives", required: false, type: "integer" }] });
    expect(doc.warnings).toEqual([]);
  }

  // Choices that only say which fields are required leave it an object.
  const required = schemaOf({ type: "object", oneOf: [{ required: ["email"] }, { required: ["phone"] }] });
  expect(required.schema).toEqual({ type: "object", oneOf: [{ type: "any" }, { type: "any" }] });
  expect(required.example).toEqual({});
});

test("a made-up example keeps to the schema's limits", () => {
  const { example } = schemaOf({
    type: "object",
    properties: {
      password: { type: "string", minLength: 8 },
      code: { type: "string", minLength: 2, maxLength: 3 },
      initial: { type: "string", maxLength: 1 },
      long: { type: "string", minLength: 1_000_000 },
      plain: { type: "string" },
      positive: { type: "integer", exclusiveMinimum: 0 },
      positive30: { type: "integer", minimum: 0, exclusiveMinimum: true },
      negative: { type: "integer", maximum: -1 },
      under: { type: "number", exclusiveMaximum: 0 },
      between: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      from: { type: "integer", minimum: 5, maximum: 10 },
      fraction: { type: "integer", minimum: 1.5 },
      any: { type: "number", minimum: -5, maximum: 5 },
      impossible: { type: "integer", minimum: 5, maximum: 1 },
      stepped: { type: "integer", minimum: 1, multipleOf: 5 },
      steppedDown: { type: "number", maximum: -1, multipleOf: 0.25 },
      both: { type: "integer", minimum: 10, exclusiveMinimum: 5 },
      bothOther: { type: "integer", minimum: 5, exclusiveMinimum: 10 },
      evens: { type: "integer", exclusiveMinimum: 2, exclusiveMaximum: 6, multipleOf: 2 },
      tenths: { type: "number", minimum: 0.3, multipleOf: 0.1 },
      position: { type: "array", items: { type: "number" }, minItems: 2 },
      list: { type: "array", items: { type: "string" } },
      crowd: { type: "array", items: { type: "boolean" }, minItems: 500 },
      unknowns: { type: "array", items: {}, minItems: 1 },
    },
  });
  expect(example).toEqual({
    password: "stringst",
    code: "str",
    initial: "s",
    long: "string".repeat(34).slice(0, 200),
    plain: "string",
    positive: 1,
    positive30: 1,
    negative: -1,
    under: -1,
    between: 0.5,
    from: 5,
    fraction: 2,
    any: 0,
    impossible: 0,
    stepped: 5,
    steppedDown: -1,
    both: 10,
    bothOther: 11,
    evens: 4,
    tenths: 0.3,
    position: [0, 0],
    list: ["string"],
    crowd: Array.from({ length: 10 }, () => true),
    unknowns: [],
  });

  // What's sent has no read-only fields; what comes back has no write-only ones.
  const user = { type: "object", properties: { id: { type: "string", readOnly: true }, name: { type: "string" }, password: { type: "string", writeOnly: true }, team: { allOf: [ref("Team")], readOnly: true } } };
  const doc = spec({
    paths: { "/users": { post: { summary: "Create", requestBody: json(ref("User")), responses: { "200": json(ref("User")) } } } },
    components: { schemas: { User: user, Team: { type: "object", properties: { name: { type: "string" } } } } },
  });
  expect(doc.operations[0]!.body!.example).toEqual({ name: "string", password: "string" });
  expect(doc.operations[0]!.responses[0]!.example).toEqual({ id: "string", name: "string", team: { name: "string" } });
});

test("the body is in JSON when it can be, else its first content type", () => {
  const doc = read(JSON.stringify(fixture));
  expect(operation(doc, "POST /posts").body).toEqual({
    required: true,
    contentType: "application/json",
    schema: {
      type: "NewPost",
      ref: "NewPost",
      properties: [
        { name: "title", required: true, type: "string", constraints: "3–200 characters" },
        { name: "body", required: false, type: "string" },
        { name: "board", required: true, type: "string", constraints: "matches ^[a-z-]+$" },
      ],
    },
    example: { title: "Export fails", board: "bugs" },
  });
  expect(operation(doc, "POST /posts/{}/comments").body).toEqual({
    required: false,
    contentType: "application/json",
    schema: { type: "object", properties: [{ name: "body", required: true, type: "string", constraints: "1–5000 characters" }] },
    example: { body: "string" },
  });
  expect(operation(doc, "GET /posts").body).toBeNull();

  const form = spec({
    paths: {
      "/a": { post: { summary: "A", requestBody: { $ref: "#/components/requestBodies/Upload" }, responses: {} }, put: { summary: "B", requestBody: { description: "Nothing." }, responses: {} } },
    },
    components: { requestBodies: { Upload: { content: { "text/csv": { schema: { type: "string", format: "binary" } }, "application/xml": {} } } } },
  });
  expect(form.operations[0]!.body).toEqual({ required: false, contentType: "text/csv", schema: { type: "string", format: "binary" }, example: "string" });
  expect(form.operations[1]!.body).toBeNull();

  const content = (types: string[]) => Object.fromEntries(types.map((type) => [type, { schema: { type: "string" } }]));
  const spelled = spec({
    paths: {
      "/a": {
        get: {
          summary: "A",
          responses: {
            "200": { content: content(["text/plain", "Application/JSON; charset=utf-8"]) },
            "400": { content: content(["text/plain", "application/problem+json", "application/json"]) },
            "500": { content: content(["text/plain", "application/problem+json"]) },
            "503": { content: content(["text/plain", "text/html"]) },
          },
        },
      },
    },
  });
  expect(spelled.operations[0]!.responses.map((response) => response.contentType)).toEqual(["Application/JSON; charset=utf-8", "application/json", "application/problem+json", "text/plain"]);
});

test("responses: each status, with the spec's example or one made from the schema", () => {
  const doc = read(JSON.stringify(fixture));
  expect(operation(doc, "POST /posts").responses.map((response) => [response.status, response.description, response.contentType, response.schema?.type, response.example])).toEqual([
    [
      "201",
      "The post.",
      "application/json",
      "Post",
      {
        number: 1,
        title: "string",
        status: "open",
        author: { id: "00000000-0000-0000-0000-000000000000", email: "e2e-ada@example.com", team: { name: "string", owner: { plan: "string" } } },
        tags: ["string"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    ["422", "Not valid.", "application/json", "Error", { message: "title is required" }],
    ["400", "What went wrong.", "application/json", "Error", { message: "string", code: 0 }],
  ]);
  expect(operation(doc, "GET /posts/{}").responses[1]).toEqual({ status: "404", description: "No such post.", contentType: null, schema: null });
  expect(operation(doc, "GET /health").responses).toEqual([{ status: "200", description: "Up.", contentType: "text/plain", schema: { type: "string" }, example: "string" }]);
  // A list that holds itself stops there.
  expect(operation(doc, "GET /posts/{}/comments").responses[0]!.example).toEqual([
    { id: "string", body: "string", author: { id: "00000000-0000-0000-0000-000000000000", email: "e2e-ada@example.com", team: { name: "string", owner: { plan: "string" } } }, replies: [] },
  ]);

  const statuses = spec({
    paths: {
      "/a": {
        get: {
          summary: "A",
          responses: {
            default: { description: "d" },
            "2xx": { description: "any" },
            "404 Not Found": { description: "nf" },
            "201 Created": { description: "a second 201" },
            Default: { description: "a second default" },
            " 500": { description: "boom" },
            "20": { description: "short" },
            "2000": { description: "long" },
            ok: { description: "word" },
            "200": {
              description: "ok",
              content: { "text/plain": {}, "application/json": { schema: { type: "object", example: { from: "schema" } }, examples: { first: { $ref: "#/components/examples/First" }, second: { value: 2 } } } },
            },
            "201": json({ type: "object", example: { from: "schema" }, properties: { a: { type: "string" } } }),
            "202": { content: { "application/json": {} } },
          },
        },
      },
    },
    components: { examples: { First: { value: { from: "examples" } } } },
  });
  expect(statuses.operations[0]!.responses.map((response) => [response.status, response.description, response.example])).toEqual([
    ["200", "ok", { from: "examples" }],
    ["201", "", { from: "schema" }],
    ["202", "", undefined],
    ["default", "d", undefined],
    ["2XX", "any", undefined],
    ["404", "nf", undefined],
    ["500", "boom", undefined],
  ]);
  expect(codes(statuses)).toEqual([
    "RESPONSE_SKIPPED @ GET /a › responses › 20",
    "RESPONSE_SKIPPED @ GET /a › responses › 2000",
    "STATUS_GUESSED @ GET /a › responses › 404 Not Found",
    "RESPONSE_SKIPPED @ GET /a › responses › 201 Created",
    "RESPONSE_SKIPPED @ GET /a › responses › Default",
    "STATUS_GUESSED @ GET /a › responses ›  500",
    "RESPONSE_SKIPPED @ GET /a › responses › ok",
  ]);
});

test("how an operation is signed: its own security, else the spec's", () => {
  const doc = read(JSON.stringify(fixture));
  expect(operation(doc, "GET /posts").auth).toEqual([["bearer"]]);
  expect(operation(doc, "POST /posts").auth).toEqual([["bearer"], ["apiKey", "workspace"]]);
  expect(operation(doc, "GET /health").auth).toEqual([]);
  expect(operation(doc, "DELETE /posts/{}")).toMatchObject({ deprecated: true, servers: [{ url: "https://admin.acme.example", description: "" }] });
  expect(operation(doc, "GET /posts")).not.toHaveProperty("servers");
  expect(operation(doc, "GET /posts").deprecated).toBe(false);

  const schemes = spec({
    security: [{ token: [] }],
    paths: {
      "/a": {
        servers: [{ url: "https://path.example" }],
        get: { summary: "A", responses: {} },
        // Its one way is a scheme the reference doesn't show: left out, with a warning.
        put: { summary: "C", security: [{ digest: [] }], responses: {} },
        post: { summary: "B", security: [{}, { ghost: [] }, { tls: [], token: [] }, { oauth: ["read"] }], servers: [{ url: "https://own.example" }], responses: {} },
      },
    },
    components: {
      securitySchemes: {
        token: { type: "http", scheme: "Bearer" },
        login: { type: "http", scheme: "basic" },
        digest: { type: "http", scheme: "digest" },
        inQuery: { type: "apiKey", in: "query", name: "api_key" },
        inCookie: { $ref: "#/components/securitySchemes/session" },
        session: { type: "apiKey", in: "cookie", name: "sid", description: "The browser's." },
        nameless: { type: "apiKey", in: "header" },
        oauth: { type: "oauth2", flows: {} },
        oidc: { type: "openIdConnect", openIdConnectUrl: "https://example.com/.well-known/openid-configuration" },
        tls: { type: "mutualTLS" },
      },
    },
  });
  expect(schemes.auth.map((one) => [one.key, one.kind, one.name])).toEqual([
    ["token", "bearer", "Authorization"],
    ["login", "basic", "Authorization"],
    ["inQuery", "query", "api_key"],
    ["inCookie", "cookie", "sid"],
    ["session", "cookie", "sid"],
    ["oauth", "oauth2", "Authorization"],
    ["oidc", "openIdConnect", "Authorization"],
  ]);
  expect(schemes.operations.map((one) => [one.auth, one.servers?.[0]?.url])).toEqual([
    [[["token"]], "https://path.example"],
    [[], "https://path.example"],
    [[[], ["oauth"]], "https://own.example"],
  ]);
  expect(codes(schemes)).toEqual([
    "UNSUPPORTED_AUTH @ securitySchemes › digest",
    "UNSUPPORTED_AUTH @ securitySchemes › nameless",
    "UNSUPPORTED_AUTH @ securitySchemes › tls",
    "SECURITY_SKIPPED @ PUT /a › security",
    "UNKNOWN_SECURITY @ POST /a › security › ghost",
    "SECURITY_SKIPPED @ POST /a › security",
  ]);
});

test("schemas read as types, limits in words", () => {
  const { schema } = schemaOf(
    {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string", minLength: 3, maxLength: 200, pattern: "^\\w+$", description: "Its **name**." },
        age: { type: "integer", format: "int32", minimum: 0, exclusiveMinimum: true, maximum: 150 },
        score: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 },
        code: { type: "string", minLength: 6, maxLength: 6 },
        one: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        posts: { type: "array", items: ref("Post"), maxItems: 50 },
        grid: { type: "array", items: { type: "array", items: { type: "number" } } },
        old3: { type: "string", nullable: true, deprecated: true },
        new31: { type: ["integer", "null"], default: null },
        either: { type: ["string", "integer"] },
        level: { enum: [1, 2, null], default: 1 },
        fixed: { const: "v1" },
        labels: { type: "object", additionalProperties: { type: "string" }, maxProperties: 5 },
        open: {},
        yes: true,
        id: { type: "string", readOnly: true },
        password: { type: "string", writeOnly: true },
        implied: { properties: { a: { type: "boolean" } } },
        list: { items: { type: "string" } },
      },
    },
    { Post: { type: "object", properties: { title: { type: "string" } } } },
  );
  const fields = Object.fromEntries(schema.properties!.map(({ name, ...rest }) => [name, rest]));
  expect(fields).toEqual({
    name: { required: true, type: "string", constraints: "3–200 characters, matches ^\\w+$", description: "Its **name**." },
    age: { required: true, type: "integer", format: "int32", constraints: "at most 150, more than 0" },
    score: { required: false, type: "number", constraints: "more than 0, less than 10, a multiple of 0.5" },
    code: { required: false, type: "string", constraints: "exactly 6 characters" },
    one: { required: false, type: "string", constraints: "at least 1 character" },
    tags: { required: false, type: "array of string", items: { type: "string" }, constraints: "at least 1 item, no two items the same" },
    posts: {
      required: false,
      type: "array of Post",
      items: { type: "Post", ref: "Post", properties: [{ name: "title", required: false, type: "string" }] },
      constraints: "at most 50 items",
    },
    grid: { required: false, type: "array of array of number", items: { type: "array of number", items: { type: "number" } } },
    old3: { required: false, type: "string", nullable: true, deprecated: true },
    new31: { required: false, type: "integer", nullable: true, default: null },
    either: { required: false, type: "string or integer" },
    level: { required: false, type: "number", nullable: true, enum: [1, 2, null], default: 1 },
    fixed: { required: false, type: "string", enum: ["v1"] },
    labels: { required: false, type: "map of string", constraints: "at most 5 fields" },
    open: { required: false, type: "any" },
    yes: { required: false, type: "any" },
    id: { required: false, type: "string", constraints: "read-only" },
    password: { required: false, type: "string", constraints: "write-only" },
    implied: { required: false, type: "object", properties: [{ name: "a", required: false, type: "boolean" }] },
    list: { required: false, type: "array of string", items: { type: "string" } },
  });
});

test("allOf is one schema; oneOf and anyOf are choices; a choice of null is nullable", () => {
  const schemas = {
    Base: { type: "object", description: "The base.", required: ["id"], properties: { id: { type: "string" }, kind: { type: "string" } } },
    Cat: { allOf: [ref("Base"), { required: ["kind"], properties: { kind: { type: "string", enum: ["cat"] }, lives: { type: "integer" } } }], description: "A cat." },
    Dog: { allOf: [ref("Base"), { allOf: [{ properties: { barks: { type: "boolean" } } }] }] },
    Pet: { oneOf: [ref("Cat"), ref("Dog")] },
  };
  const { schema, example, doc } = schemaOf(
    {
      type: "object",
      properties: {
        pet: ref("Pet"),
        maybe: { anyOf: [ref("Dog"), { type: "null" }], description: "A dog, if any." },
        mixed: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
      },
    },
    schemas,
  );
  const [pet, maybe, mixed] = schema.properties!;
  expect(pet).toMatchObject({ type: "Pet", ref: "Pet", oneOf: [{ type: "Cat", ref: "Cat", description: "A cat." }, { type: "Dog", ref: "Dog", description: "The base." }] });
  expect(pet!.oneOf![0]!.properties).toEqual([
    { name: "id", required: true, type: "string" },
    { name: "kind", required: true, type: "string", enum: ["cat"] },
    { name: "lives", required: false, type: "integer" },
  ]);
  expect(pet!.oneOf![1]!.properties!.map((property) => property.name)).toEqual(["id", "kind", "barks"]);
  expect(maybe).toMatchObject({ type: "Dog", ref: "Dog", nullable: true, description: "A dog, if any." });
  expect(mixed).toEqual({ name: "mixed", required: false, type: "string or integer", nullable: true, oneOf: [{ type: "string" }, { type: "integer" }] });
  expect(example).toEqual({ pet: { id: "string", kind: "cat", lives: 0 }, maybe: { id: "string", kind: "string", barks: true }, mixed: "string" });
  expect(doc.types.map((type) => [type.name, type.kind, type.schema.type])).toEqual([
    ["Base", "object", "object"],
    ["Cat", "object", "object"],
    ["Dog", "object", "object"],
    ["Pet", "union", "Cat or Dog"],
  ]);
});

test("a named schema is spelled out where it's first met and two levels down, and never inside itself", () => {
  const doc = read(JSON.stringify(fixture));
  const names = (schema: ApiSchema | undefined) => schema?.properties?.map((property) => property.name);
  const field = (schema: ApiSchema | undefined, name: string) => schema?.properties?.find((property) => property.name === name);

  // In an operation: Comment, its User and that User's Team; the Team's Account is only named.
  const comment = operation(doc, "POST /posts/{}/comments").responses[0]!.schema!;
  expect(comment).toMatchObject({ type: "Comment", ref: "Comment" });
  expect(names(comment)).toEqual(["id", "body", "author", "replies"]);
  const team = field(field(comment, "author"), "team");
  expect(names(team)).toEqual(["name", "owner"]);
  expect(field(team, "owner")).toEqual({ name: "owner", required: false, type: "Account", ref: "Account" });
  // Itself, in itself: only named.
  expect(field(comment, "replies")).toEqual({ name: "replies", required: false, type: "array of Comment", items: { type: "Comment", ref: "Comment" } });

  // On its own page it's the first met: its kind of value as the type, and the same two levels.
  const page = doc.types.find((type) => type.name === "Comment")!.schema;
  expect(page).toMatchObject({ type: "object", ref: "Comment" });
  expect(field(field(field(page, "author"), "team"), "owner")).toEqual({ name: "owner", required: false, type: "Account", ref: "Account" });
  expect(field(page, "replies")!.items).toEqual({ type: "Comment", ref: "Comment" });
  expect(doc.types.find((type) => type.name === "Status")!.schema).toEqual({ type: "string", ref: "Status", enum: ["open", "planned", "done"], default: "open" });

  // An unnamed schema under a named one counts no level.
  const { schema } = schemaOf(ref("A"), {
    A: { type: "object", properties: { b: { type: "object", properties: { deep: { type: "array", items: ref("B") } } } } },
    B: { type: "object", properties: { c: ref("C") } },
    C: { type: "object", properties: { d: ref("D") } },
    D: { type: "object", properties: { e: { type: "string" } } },
  });
  const c = field(field(field(schema, "b"), "deep")!.items, "c");
  expect(c).toMatchObject({ type: "C", ref: "C", properties: [{ name: "d", required: false, type: "D", ref: "D" }] });
});

test("a reference inside allOf is still a reference: named, and never spelled out inside itself", () => {
  const { schema, example, doc } = schemaOf(ref("Category"), {
    Category: {
      type: "object",
      properties: {
        id: { type: "string" },
        // How 3.0 says "this type, or null".
        parent: { allOf: [ref("Category")], nullable: true, description: "The one above." },
        owner: { allOf: [ref("User")], nullable: true },
        // Itself with more: folded in nowhere, since it's inside itself.
        twin: { allOf: [ref("Category"), { properties: { extra: { type: "string" } } }] },
      },
    },
    User: { type: "object", properties: { name: { type: "string" } } },
    Tree: { allOf: [ref("Node"), { properties: { root: ref("Tree") } }] },
    Node: { type: "object", properties: { next: { allOf: [ref("Node"), { description: "The next." }] } } },
  });
  const expected = [
    { name: "id", required: false, type: "string" },
    { name: "parent", required: false, type: "Category", ref: "Category", nullable: true, description: "The one above." },
    { name: "owner", required: false, type: "User", ref: "User", nullable: true, properties: [{ name: "name", required: false, type: "string" }] },
    { name: "twin", required: false, type: "Category", ref: "Category" },
  ];
  expect(schema.properties).toEqual(expected);
  expect(doc.types[0]!.schema.properties).toEqual(expected);
  expect(example).toEqual({ id: "string", owner: { name: "string" } });
  // Folded in, a type's own fields are under it: Node's `next` is Node, named.
  expect(doc.types[2]!.schema.properties).toEqual([
    // A description in a part of its own is still only words about the reference.
    { name: "next", required: false, type: "Node", ref: "Node", description: "The next.", properties: [{ name: "next", required: false, type: "Node", ref: "Node", description: "The next." }] },
    { name: "root", required: false, type: "Tree", ref: "Tree" },
  ]);
  // What `twin` adds to the type it's inside is left out, and said so.
  expect(codes(doc)).toEqual(["ADDS_TO_ITSELF @ schemas › Category › twin"]);
});

test("a field that is its own type keeps its own words, whatever else is beside the reference", () => {
  const { doc } = schemaOf(ref("Node"), {
    Node: {
      type: "object",
      properties: {
        parent: { allOf: [ref("Node")], readOnly: true, type: "object", nullable: true, deprecated: true, default: null, description: "The one above." },
        more: { allOf: [ref("Node")], properties: { extra: { type: "string" } }, description: "With more." },
      },
    },
  });
  expect(doc.types[0]!.schema.properties).toEqual([
    { name: "parent", required: false, type: "Node", ref: "Node", description: "The one above.", nullable: true, deprecated: true, constraints: "read-only", default: null },
    { name: "more", required: false, type: "Node", ref: "Node", description: "With more." },
  ]);
  // Only what's really left out is warned about.
  expect(codes(doc)).toEqual(["ADDS_TO_ITSELF @ schemas › Node › more"]);
});

test("a schema that holds itself through a part of a part still ends", () => {
  const { schema, doc } = schemaOf(ref("Self"), { Self: { type: "object", properties: { id: { type: "string" }, again: { allOf: [{ allOf: [ref("Self")], properties: { more: { type: "string" } } }] } } } });
  expect(schema.properties![1]).toEqual({
    name: "again",
    required: false,
    type: "object",
    properties: [
      { name: "id", required: false, type: "string" },
      { name: "again", required: false, type: "object" },
      { name: "more", required: false, type: "string" },
    ],
  });
  expect(codes(doc)).toEqual(["ADDS_TO_ITSELF @ schemas › Self › again › again"]);

  // With a reference to another type beside the part that loops, it isn't named after that type.
  const beside = schemaOf(ref("Self"), {
    Other: { type: "object", properties: { other: { type: "string" } } },
    Self: { type: "object", properties: { id: { type: "string" }, again: { allOf: [ref("Other"), { allOf: [ref("Self")] }] } } },
  });
  const again = beside.schema.properties![1]!;
  expect(again.properties!.map((property) => [property.name, property.type])).toEqual([
    ["other", "string"],
    ["id", "string"],
    ["again", "object"],
  ]);
  expect(again.properties![2]).toEqual({ name: "again", required: false, type: "object" });
  expect(codes(beside.doc)).toEqual(["ADDS_TO_ITSELF @ schemas › Self › again › again"]);
});

test("types that share an allOf base are spelled out inside each other", () => {
  const { schema, example, doc } = schemaOf(ref("Pet"), {
    Resource: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    Person: { allOf: [ref("Resource"), { properties: { name: { type: "string" } } }] },
    Pet: { allOf: [ref("Resource"), { properties: { owner: ref("Person"), vet: { allOf: [ref("Person")], nullable: true } } }] },
  });
  const person = [
    { name: "id", required: true, type: "string" },
    { name: "name", required: false, type: "string" },
  ];
  expect(schema).toEqual({
    type: "Pet",
    ref: "Pet",
    properties: [
      { name: "id", required: true, type: "string" },
      { name: "owner", required: false, type: "Person", ref: "Person", properties: person },
      { name: "vet", required: false, type: "Person", ref: "Person", nullable: true, properties: person },
    ],
  });
  expect(example).toEqual({ id: "string", owner: { id: "string", name: "string" }, vet: { id: "string", name: "string" } });
  // A field that is the base itself, too.
  const dog = schemaOf(ref("Dog"), {
    Animal: { type: "object", properties: { legs: { type: "integer" } } },
    Dog: { allOf: [ref("Animal"), { properties: { friend: ref("Animal") } }] },
  });
  expect(dog).toMatchObject({
    schema: { type: "Dog", properties: [{ name: "legs", type: "integer" }, { name: "friend", type: "Animal", ref: "Animal", properties: [{ name: "legs", required: false, type: "integer" }] }] },
    example: { legs: 0, friend: { legs: 0 } },
  });
  expect(doc.warnings).toEqual([]);
});

test("keywords beside a lone allOf reference are kept", () => {
  const { schema, example } = schemaOf(
    {
      type: "object",
      properties: {
        id: { allOf: [ref("Uuid")], readOnly: true },
        code: { allOf: [ref("Text")], maxLength: 10, enum: ["a", "b"] },
        more: { allOf: [ref("Thing")], properties: { extra: { type: "boolean" } } },
        plain: { allOf: [ref("Text")], description: "Just words.", nullable: true, default: "x", title: "Plain", "x-internal": true },
        author: { allOf: [ref("Thing"), { description: "Who wrote it.", nullable: true }] },
      },
    },
    { Uuid: { type: "string", format: "uuid" }, Text: { type: "string", minLength: 1 }, Thing: { type: "object", description: "A thing.", properties: { a: { type: "string" } } } },
  );
  expect(schema.properties).toEqual([
    { name: "id", required: false, type: "string", format: "uuid", constraints: "read-only" },
    { name: "code", required: false, type: "string", constraints: "1–10 characters", enum: ["a", "b"] },
    {
      name: "more",
      required: false,
      type: "object",
      description: "A thing.",
      properties: [
        { name: "a", required: false, type: "string" },
        { name: "extra", required: false, type: "boolean" },
      ],
    },
    { name: "plain", required: false, type: "Text", ref: "Text", description: "Just words.", nullable: true, default: "x", constraints: "at least 1 character" },
    // The field's own words win over the type's, and it's still the type.
    { name: "author", required: false, type: "Thing", ref: "Thing", description: "Who wrote it.", nullable: true, properties: [{ name: "a", required: false, type: "string" }] },
  ]);
  expect(example).toEqual({ id: "00000000-0000-0000-0000-000000000000", code: "a", more: { extra: true, a: "string" }, plain: "x", author: { a: "string" } });
});

test("a spec whose schemas fan out without end is read in bounded time, with a warning", () => {
  const wide = (to: string) => ({ type: "object", properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}`, ref(to)])) });
  const inline = (levels: number): object => (levels === 0 ? { type: "string" } : { type: "object", properties: { a: inline(levels - 1), b: inline(levels - 1) } });
  const doc = spec({
    paths: { "/a": { get: { summary: "Wide", responses: { "200": json(ref("A")), "201": json(inline(12)) } } } },
    components: { schemas: { A: wide("B"), B: wide("C"), C: wide("D"), D: wide("A") } },
  });
  expect(JSON.stringify(doc).length).toBeLessThan(3_000_000);
  expect(doc.operations[0]!.responses[0]!.schema!.properties).toHaveLength(60);
  expect(codes(doc)).toEqual(["SCHEMA_TOO_LARGE @ GET /a › responses › 201"]);
});

test("a schema with more fields than fit is cut short, however often it's used", () => {
  const names = Array.from({ length: 10_000 }, (_, index) => `f${index}`);
  const big = { type: "object", required: names, properties: Object.fromEntries(names.map((name) => [name, {}])) };
  const paths = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`/p${index}`, { get: { summary: `P${index}`, responses: { "200": json(ref("Big")) } } }]));
  const doc = spec({ paths, components: { schemas: { Big: big } } });
  const response = doc.operations[19]!.responses[0]!;
  expect(response.schema!.properties!.length).toBeLessThanOrEqual(4_000);
  expect(Object.keys(response.example as object).length).toBeLessThanOrEqual(4_000);
  expect(response.schema!.properties![0]).toEqual({ name: "f0", required: true, type: "any" });
  expect(response.schema!.properties!.every((property) => property.required)).toBe(true);
  expect(JSON.stringify(doc).length).toBeLessThan(6_000_000);
  expect(codes(doc)).toContain("SCHEMA_TOO_LARGE @ schemas › Big");
  expect(codes(doc)).toContain("SCHEMA_TOO_LARGE @ GET /p19 › responses › 200");
});

test("a mixed-case default is default", () => {
  const doc = spec({ paths: { "/a": { get: { summary: "A", responses: { Default: { description: "d" }, "2xx": { description: "ok" } } } } } });
  expect(doc.operations[0]!.responses.map((response) => response.status)).toEqual(["default", "2XX"]);
  expect(doc.warnings).toEqual([]);
});

test("many schemas that each fold in one wide schema stop the read early", () => {
  const base = { type: "object", properties: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`f${index}`, {}])) };
  const schemas = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`S${index}`, { allOf: [ref("Base"), { properties: { own: {} } }] }]));
  const text = JSON.stringify({ openapi: "3.0.0", paths: {}, components: { schemas: { Base: base, ...schemas } } });
  expect(errorOf(text, { values: 20_000 })).toMatch(/too large once its references are followed/);
  // A few of them are read, each with the base's fields.
  const few = spec({ components: { schemas: { Base: { type: "object", required: ["id"], properties: { id: {} } }, A: { allOf: [ref("Base")] }, B: { allOf: [ref("Base"), ref("A")] } } } });
  expect(few.types.map((type) => type.schema.properties)).toEqual(Array.from({ length: 3 }, () => [{ name: "id", required: true, type: "any" }]));
});

test("a very long allOf counts as its length each time it's used", () => {
  const wide = { allOf: Array.from({ length: 5_000 }, () => ref("Leaf")) };
  const holder = { type: "object", properties: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`f${index}`, ref("Wide")])) };
  const { schema, doc } = schemaOf(ref("Holder"), { Leaf: { type: "string" }, Wide: wide, Holder: holder });
  // The first use spends the schema's room, so the other 299 aren't gone through, and that's said.
  expect(schema.properties).toEqual([{ name: "f0", required: false, type: "Wide", ref: "Wide" }]);
  expect(codes(doc)).toContain("SCHEMA_TOO_LARGE @ GET /x › responses › 200");
});

test("an allOf part that can't be followed is warned about", () => {
  const { schema, doc } = schemaOf({ allOf: [{ $ref: "common.yaml#/components/schemas/Error" }, ref("Missing"), { properties: { x: { type: "string" } } }] });
  expect(schema).toEqual({ type: "object", properties: [{ name: "x", required: false, type: "string" }] });
  expect(codes(doc)).toEqual(["OUTSIDE_REF @ GET /x › responses › 200", "UNKNOWN_REF @ GET /x › responses › 200"]);
});

test("a long list of choices, used by thousands of fields, is gone through once", () => {
  const big = { oneOf: Array.from({ length: 50_000 }, () => ({})) };
  const many = { type: "object", properties: Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`f${index}`, ref("Big")])) };
  const paths = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`/${index}`, { get: { summary: `S${index}`, responses: { "200": json(ref("A")) } } }]));
  const chain = (to: string) => ({ type: "object", properties: { next: ref(to) } });
  const text = JSON.stringify({ openapi: "3.0.0", paths, components: { schemas: { Big: big, D: many, A: chain("B"), B: chain("C"), C: chain("D") } } });
  // How often a list as long as Big's is filtered: once, not for every field of every response.
  let scans = 0;
  const filter = Array.prototype.filter;
  const spy = vi.spyOn(Array.prototype, "filter").mockImplementation(function (this: unknown[], ...args: Parameters<typeof filter>) {
    if (this.length >= 50_000) scans++;
    return filter.apply(this, args);
  });
  const result = readOpenApi(text);
  spy.mockRestore();
  expect("doc" in result ? result.doc.operations.length : result.error).toBeTruthy();
  expect(scans).toBe(1);
});

test("a YAML file that's too large once its aliases are filled in is an error", () => {
  const tooLarge = "This file is too large once its YAML aliases are filled in. Use fewer aliases of its largest anchors.";
  const small = { yamlSize: 20_000 };
  const aliases = Array.from({ length: 90 }, (_, index) => `  a${index}: *big`).join("\n");
  const text = `openapi: 3.0.0\nx-big: &big "${"x".repeat(300)}"\nx-uses:\n${aliases}\n`;
  expect(text.length).toBeLessThan(2_000);
  expect(errorOf(text, small)).toBe(tooLarge);
  // The same file is an ordinary one where the limit is the real one, and so is a few uses under the small one.
  expect(errorOf(text)).toBeNull();
  expect(errorOf(`openapi: 3.0.0\nx-big: &big "${"x".repeat(300)}"\nx-uses: [*big, *big, *big]\n`, small)).toBeNull();
  // An anchor that holds itself isn't a file to read, and that's what the error says.
  expect(errorOf("openapi: 3.0.0\na: &a\n  b: *a\n")).toBe("This file isn't valid JSON or YAML: an alias holds itself");
  // One small anchor used hundreds of times, as a value and merged in, is an ordinary spec.
  const uses = Array.from({ length: 300 }, (_, index) => `        "${200 + index}": *ok`).join("\n");
  const merges = Array.from({ length: 300 }, (_, index) => `    M${index}:\n      <<: *base\n      description: D${index}`).join("\n");
  const many = read(`openapi: 3.0.0\nx-ok: &ok { description: Fine }\nx-base: &base { type: object, properties: { id: { type: string } } }\npaths:\n  /a:\n    get:\n      summary: A\n      responses:\n${uses}\ncomponents:\n  schemas:\n${merges}\n`);
  expect(many.operations[0]!.responses).toHaveLength(300);
  expect(many.types).toHaveLength(300);
  expect(many.types[299]!.schema).toEqual({ type: "object", ref: "M299", description: "D299", properties: [{ name: "id", required: false, type: "string" }] });
  // Many merges of a large anchor are measured before any is filled in.
  const wide = Array.from({ length: 200 }, (_, index) => `k${index}: 1`).join(", ");
  const merged = Array.from({ length: 50 }, (_, index) => `  m${index}: { <<: *wide }`).join("\n");
  expect(errorOf(`openapi: 3.0.0\nx-wide: &wide { ${wide} }\nx-uses:\n${merged}\n`, small)).toBe(tooLarge);
  // Bytes count as what they become, not as a short value.
  const bytes = Buffer.alloc(150, 7).toString("base64");
  expect(errorOf(`%YAML 1.1\n---\nopenapi: 3.0.0\nx-b: &b !!binary ${bytes}\nx-uses: [${Array.from({ length: 20 }, () => "*b").join(", ")}]\n`, small)).toBe(tooLarge);
});

test("a YAML file with more anchors and aliases than may be is an error, before any is filled in", () => {
  // Filling an alias in goes back over the anchors and aliases before it, so it's their number that's bounded, not only their size.
  const list = (count: number) => `openapi: 3.0.0\nx-a: &a ""\nx-uses:\n${"  - *a\n".repeat(count)}`;
  expect(errorOf(list(10_000))).toBe("This file has more than 10,000 YAML anchors and aliases. Use fewer of them.");
  expect(errorOf(list(100))).toBeNull();
  // Anchors count as aliases do.
  const anchors = `openapi: 3.0.0\nx-anchors:\n${Array.from({ length: 60 }, (_, index) => `  - &a${index} ${index}`).join("\n")}\n`;
  expect(errorOf(anchors, { yamlAnchors: 50 })).toBe("This file has more than 50 YAML anchors and aliases. Use fewer of them.");
  expect(errorOf(anchors, { yamlAnchors: 60 })).toBeNull();
});

test("a path item that many paths point at counts for each of them", () => {
  const item = (params: number, statuses: number) => ({
    parameters: Array.from({ length: params }, (_, index) => ({ name: `p${index}`, in: "query" })),
    get: { summary: "S", tags: ["T"], responses: Object.fromEntries(Array.from({ length: statuses }, (_, index) => [String(200 + index), { description: "d" }])) },
  });
  const pointing = (count: number, shared: object) =>
    JSON.stringify({ openapi: "3.1.0", paths: Object.fromEntries(Array.from({ length: count }, (_, index) => [`/${index}`, { $ref: "#/components/pathItems/Shared" }])), components: { pathItems: { Shared: shared } } });
  const small = { values: 20_000 };
  const tooLarge = /too large once its references are followed/;
  // Parameters without a schema, and responses without content, are values like any other.
  expect(errorOf(pointing(40, item(600, 1)), small)).toMatch(tooLarge);
  expect(errorOf(pointing(100, item(0, 300)), small)).toMatch(tooLarge);
  // So are a shared item's other keys, and an operation's tags and servers: each alone is too much.
  const keys = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`x-${index}`, 1]));
  expect(errorOf(pointing(30, { ...keys, get: { summary: "S" } }), small)).toMatch(tooLarge);
  const tags = Array.from({ length: 600 }, (_, index) => `T${index}`);
  expect(errorOf(pointing(40, { get: { summary: "S", tags } }), small)).toMatch(tooLarge);
  const servers = Array.from({ length: 600 }, (_, index) => ({ url: `https://s${index}.example.com` }));
  expect(errorOf(pointing(40, { get: { summary: "S", servers } }), small)).toMatch(tooLarge);
  // Each of them reads where the limit is the real one.
  expect(errorOf(pointing(40, { get: { summary: "S", tags, servers } }))).toBeNull();
  const few = read(pointing(50, item(20, 3)));
  expect(few.operations).toHaveLength(50);
  expect(few.operations[49]).toMatchObject({ key: "GET /49", group: "T", params: { length: 20 }, responses: { length: 3 } });
});

test("the spec's own security list counts for every operation that has none of its own", () => {
  const paths = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`/${index}`, { get: { summary: `S${index}` } }]));
  const securitySchemes = { bearer: { type: "http", scheme: "bearer" } };
  const small = { values: 20_000 };
  const long = { openapi: "3.0.0", security: Array.from({ length: 200 }, () => ({ bearer: [] })), paths: paths(150), components: { securitySchemes } };
  expect(errorOf(JSON.stringify(long), small)).toMatch(/too large once its references are followed/);
  const short = spec({ security: [{ bearer: [] }, {}], paths: paths(150), components: { securitySchemes } });
  expect(short.operations).toHaveLength(150);
  expect(short.operations[149]!.auth).toEqual([["bearer"], []]);

  // Each name in a requirement counts too, and the warnings about them stop at a number a team could read.
  const names = { openapi: "3.0.0", security: [Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`s${index}`, []]))], paths: paths(60) };
  expect(errorOf(JSON.stringify(names), small)).toMatch(/too large once its references are followed/);
  const fewer = spec({ security: [Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`s${index}`, []]))], paths: paths(20) });
  expect(fewer.operations).toHaveLength(20);
  expect(fewer.warnings).toHaveLength(10_000);
});

test("after many large types, an operation's own schemas are still read", () => {
  const schemas = Object.fromEntries(
    Array.from({ length: 150 }, (_, index) => [`S${index}`, { type: "object", properties: Object.fromEntries(Array.from({ length: 30 }, (_, field) => [`f${field}`, ref(`S${(index + 1) % 150}`)])) }]),
  );
  const doc = spec({
    paths: { "/a": { get: { summary: "A", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": json({ type: "object", properties: { id: { type: "string" }, first: ref("S0") } }) } } } },
    components: { schemas },
  });
  const [get] = doc.operations;
  expect(get!.params[0]!.schema).toEqual({ type: "integer" });
  expect(get!.responses[0]!.schema!.properties!.slice(0, 2)).toMatchObject([{ name: "id", type: "string" }, { name: "first", type: "S0", ref: "S0" }]);
  expect(get!.responses[0]!.example).toMatchObject({ id: "string" });
  expect(doc.types).toHaveLength(150);
  // The last types, read once the doc's room is spent, still list their fields.
  expect(doc.types[149]!.schema.properties).toHaveLength(30);
  expect(doc.types[149]!.schema.properties![29]).toMatchObject({ name: "f29", type: "S0", ref: "S0" });
});

test("what many places share is made once: a long pattern, a list of servers, a title", () => {
  const paths = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`/${index}`, { $ref: "#/components/pathItems/Shared" }]));
  const shared = {
    servers: [{ url: "https://{v}.example.com", variables: { v: { default: "a", enum: ["a", "b"] } } }],
    get: { operationId: "listAllTheThings", responses: { "200": json({ type: "object", properties: { a: ref("Code"), b: ref("Code") } }) } },
  };
  // How often the limits are put into words and the operationId into a title: once each, not once per use.
  let joins = 0;
  let titles = 0;
  const join = Array.prototype.join;
  const replace = String.prototype.replace;
  const joined = vi.spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], ...args: Parameters<typeof join>) {
    if (this.includes("matches ^[a-z]+$")) joins++;
    return join.apply(this, args);
  });
  const replaced = vi.spyOn(String.prototype, "replace").mockImplementation(function (this: string, ...args: unknown[]) {
    if (String(this) === "listAllTheThings") titles++;
    return (replace as (...all: unknown[]) => string).apply(this, args);
  });
  const doc = spec({ openapi: "3.1.0", paths, components: { pathItems: { Shared: shared }, schemas: { Code: { type: "string", pattern: "^[a-z]+$" } } } });
  joined.mockRestore();
  replaced.mockRestore();
  expect(joins).toBe(1);
  expect(titles).toBe(1);
  // A summary is trimmed once for the operation, not for every path that points at it.
  let trims = 0;
  const trim = String.prototype.trim;
  const trimmed = vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
    if (String(this) === "  Padded  ") trims++;
    return trim.call(this);
  });
  const padded = spec({ openapi: "3.1.0", paths, components: { pathItems: { Shared: { get: { summary: "  Padded  " } } } } });
  trimmed.mockRestore();
  expect(padded.operations.map((one) => one.title)).toEqual(Array.from({ length: 30 }, () => "Padded"));
  expect(trims).toBe(1);
  const [first, second] = doc.operations;
  expect(second!.servers).toBe(first!.servers);
  expect(first!.servers![0]!.variables).toEqual({ v: { default: "a", enum: ["a", "b"], description: "" } });
  expect(doc.operations.map((one) => one.title)).toEqual(Array.from({ length: 30 }, () => "List all the things"));
  expect(doc.operations[29]!.slug).toBe("list-all-the-things-30");
  const [a, b] = first!.responses[0]!.schema!.properties!;
  expect(a!.constraints).toBe("matches ^[a-z]+$");
  expect(b!.constraints).toBe(a!.constraints);
});

test("a type whose reference is spelled another way is still not spelled out inside itself", () => {
  const doc = spec({
    components: { schemas: { "User Response": { type: "object", properties: { id: { type: "string" }, self: { $ref: "#/components/schemas/User%20Response" }, tilde: { $ref: "#/components/schemas/a~1b" } } }, "a/b": { type: "object", properties: { again: { $ref: "#/components/schemas/a%7E1b" } } } } },
  });
  expect(doc.types[0]!.schema.properties).toEqual([
    { name: "id", required: false, type: "string" },
    { name: "self", required: false, type: "User Response", ref: "User Response" },
    { name: "tilde", required: false, type: "a/b", ref: "a/b", properties: [{ name: "again", required: false, type: "a/b", ref: "a/b" }] },
  ]);
});

test("a schema's own word on a field counts over the one it folds in", () => {
  const { schema, example } = schemaOf(ref("Dog"), {
    Pet: { type: "object", description: "A pet.", required: ["kind"], properties: { kind: { type: "string", description: "The pet's kind." }, name: { type: "string" } } },
    Dog: { allOf: [ref("Pet")], description: "A dog.", properties: { kind: { type: "string", enum: ["dog"] }, barks: { type: "boolean" } } },
  });
  expect(schema).toEqual({
    type: "Dog",
    ref: "Dog",
    description: "A dog.",
    properties: [
      { name: "kind", required: true, type: "string", enum: ["dog"] },
      { name: "name", required: false, type: "string" },
      { name: "barks", required: false, type: "boolean" },
    ],
  });
  expect(example).toEqual({ kind: "dog", name: "string", barks: true });

  // Two levels down too: what Pup folds in has Dog's word on `kind`, not Pet's.
  const pup = schemaOf(ref("Pup"), {
    Pet: { type: "object", description: "A pet.", properties: { kind: { type: "string", description: "The pet's kind." } } },
    Dog: { allOf: [ref("Pet")], properties: { kind: { type: "string", enum: ["dog"] } } },
    Pup: { allOf: [ref("Dog"), { properties: { age: { type: "integer" } } }] },
  });
  expect(pup.schema).toEqual({
    type: "Pup",
    ref: "Pup",
    description: "A pet.",
    properties: [
      { name: "kind", required: false, type: "string", enum: ["dog"] },
      { name: "age", required: false, type: "integer" },
    ],
  });
  expect(pup.example).toEqual({ kind: "dog", age: 0 });
  expect(pup.doc.types.map((type) => type.schema.properties![0])).toEqual([
    { name: "kind", required: false, type: "string", description: "The pet's kind." },
    { name: "kind", required: false, type: "string", enum: ["dog"] },
    { name: "kind", required: false, type: "string", enum: ["dog"] },
  ]);
});

test("one rule when parts are folded in: a later part's word counts, and a schema's own over all", () => {
  const schemas = {
    Pet: { type: "object", description: "A pet.", example: { kind: "cat" }, properties: { kind: { type: "string", description: "Any kind." } } },
    // The common way to extend a type: its own words and fields in a part after the base.
    Dog: { allOf: [ref("Pet"), { description: "A dog.", example: { kind: "dog", barks: true }, properties: { kind: { type: "string", enum: ["dog"] }, barks: { type: "boolean" } } }] },
    // Two levels down, with a word of its own beside `allOf`, which counts over its parts'.
    Pup: { allOf: [ref("Dog"), { description: "A part's word.", maxProperties: 3, properties: { barks: { type: "boolean", description: "Squeaks." } } }], description: "A pup." },
  };
  const dog = schemaOf(ref("Dog"), schemas);
  expect(dog.schema).toEqual({
    type: "Dog",
    ref: "Dog",
    description: "A dog.",
    properties: [
      { name: "kind", required: false, type: "string", enum: ["dog"] },
      { name: "barks", required: false, type: "boolean" },
    ],
  });
  expect(dog.example).toEqual({ kind: "dog", barks: true });
  const pup = schemaOf(ref("Pup"), schemas);
  expect(pup.schema).toEqual({
    type: "Pup",
    ref: "Pup",
    description: "A pup.",
    constraints: "at most 3 fields",
    properties: [
      { name: "kind", required: false, type: "string", enum: ["dog"] },
      { name: "barks", required: false, type: "boolean", description: "Squeaks." },
    ],
  });
  // Dog's example, the nearest one said: Pet's is under it.
  expect(pup.example).toEqual({ kind: "dog", barks: true });
  expect(pup.doc.types.map((type) => type.schema.description)).toEqual(["A pet.", "A dog.", "A pup."]);

  // A base's example or default isn't of a type that adds fields to it: that one's is made from all its fields.
  const based = schemaOf(ref("Cat"), {
    Pet: { type: "object", example: { name: "Rex" }, default: { name: "Rex" }, properties: { name: { type: "string" } } },
    Cat: { allOf: [ref("Pet"), { required: ["lives"], properties: { lives: { type: "integer" } } }] },
    // With nothing added, it's still the base's.
    Same: { allOf: [ref("Pet")], description: "A pet by another name." },
  });
  expect(based.example).toEqual({ name: "string", lives: 0 });
  expect(based.schema).not.toHaveProperty("default");
  // In either order, and with the base's example in a part of the base's own.
  const reversed = schemaOf(ref("Cat"), {
    Animal: { type: "object", properties: { name: { type: "string" } } },
    Pet: { allOf: [ref("Animal"), { example: { name: "Rex" } }] },
    Cat: { allOf: [{ required: ["lives"], properties: { lives: { type: "integer" } } }, ref("Pet")] },
    Wrapped: { allOf: [ref("Pet")] },
  });
  expect(reversed.example).toEqual({ lives: 0, name: "string" });
  // Pet's own example is of all of Pet, whatever Pet is made of.
  expect(reversed.doc.types.map((type) => type.name)).toEqual(["Animal", "Pet", "Cat", "Wrapped"]);
  const wrapped = schemaOf(ref("Pet"), { Animal: { type: "object", properties: { name: { type: "string" } } }, Pet: { allOf: [ref("Animal"), { example: { name: "Rex" } }] } });
  expect(wrapped.example).toEqual({ name: "Rex" });

  // At any depth: Animal's example isn't Pet's, which adds a field, so it isn't Dog's either, which only adds words to Pet.
  const levels = {
    Animal: { type: "object", example: { kind: "cat" }, default: { kind: "cat" }, properties: { kind: { type: "string" } } },
    Pet: { allOf: [ref("Animal"), { properties: { name: { type: "string" } } }] },
    Dog: { allOf: [ref("Pet")], description: "A dog.", readOnly: true },
    // An example of Pet's own is Pet's, and so Puppy's, which adds nothing to it; Kitten adds a field.
    Owned: { allOf: [ref("Pet")], example: { kind: "dog", name: "Rex" } },
    Puppy: { allOf: [ref("Owned"), { description: "A young one." }], readOnly: true },
    Kitten: { allOf: [ref("Owned"), { properties: { lives: { type: "integer" } } }] },
  };
  const made = { kind: "string", name: "string" };
  expect(schemaOf(ref("Pet"), levels).example).toEqual(made);
  const worded = schemaOf(ref("Dog"), levels);
  expect(worded.example).toEqual(made);
  expect(worded.schema).not.toHaveProperty("default");
  expect(worded.schema).toMatchObject({ type: "Dog", description: "A dog.", constraints: "read-only" });
  expect(schemaOf(ref("Animal"), levels)).toMatchObject({ example: { kind: "cat" }, schema: { default: { kind: "cat" } } });
  expect(schemaOf(ref("Puppy"), levels).example).toEqual({ kind: "dog", name: "Rex" });
  expect(schemaOf(ref("Kitten"), levels).example).toEqual({ kind: "string", name: "string", lives: 0 });

  // The schema's own example and default, written in a part before a base that has its own, are still the schema's.
  const first = schemaOf(ref("Cat"), {
    Pet: { type: "object", example: { name: "Rex" }, default: { name: "Rex" }, properties: { name: { type: "string" } } },
    Cat: { allOf: [{ properties: { lives: { type: "integer" } }, example: { lives: 9, name: "Tom" }, default: { lives: 9 } }, ref("Pet")] },
  });
  expect(first.example).toEqual({ lives: 9, name: "Tom" });
  expect(first.schema.default).toEqual({ lives: 9 });

  // Written 3.1's way, `examples`, its own is still the one shown over a base's `example`, and the other way round.
  const either = (openapi: string) =>
    read(
      JSON.stringify({
        openapi,
        paths: { "/x": { get: { summary: "X", responses: { "200": json({ $ref: "#/components/schemas/Pet", examples: [{ name: "Tom" }] }), "201": json(ref("Cat")), "202": json(ref("Old")) } } } },
        components: {
          schemas: {
            Pet: { type: "object", example: { name: "Rex" }, properties: { name: { type: "string" } } },
            Cat: { allOf: [ref("Pet")], examples: [{ name: "Tom" }] },
            Newer: { type: "object", examples: [{ name: "Rex" }], properties: { name: { type: "string" } } },
            Old: { allOf: [ref("Newer")], example: { name: "Tom" } },
          },
        },
      }),
    ).operations[0]!.responses.map((response) => response.example);
  expect(either("3.1.0")).toEqual([{ name: "Tom" }, { name: "Tom" }, { name: "Tom" }]);
  // In 3.0 what's beside a reference doesn't count; what's written beside `allOf` does.
  expect(either("3.0.3")).toEqual([{ name: "Rex" }, { name: "Tom" }, { name: "Tom" }]);
  expect(based.doc.types[2]!.schema).toMatchObject({ type: "Pet", ref: "Same", default: { name: "Rex" }, description: "A pet by another name." });
});

test("a schema of fields that are only true counts like any other", () => {
  const wide = (count: number) => ({ type: "object", properties: Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, index % 2 === 0])) });
  const one = schemaOf(ref("W"), { W: wide(6_000) });
  expect(one.schema.properties!.length).toBeLessThanOrEqual(4_000);
  expect(one.schema.properties![1]).toEqual({ name: "f1", required: false, type: "any" });
  expect(Object.keys(one.example as object)).toEqual([]);
  expect(codes(one.doc)).toEqual(["SCHEMA_TOO_LARGE @ schemas › W", "SCHEMA_TOO_LARGE @ GET /x › responses › 200"]);
  // Used by many operations, it's too much, as a schema of that many strings would be.
  const paths = Object.fromEntries(Array.from({ length: 2_500 }, (_, index) => [`/${index}`, { get: { summary: `S${index}`, responses: { "200": json(ref("W")) } } }]));
  expect(errorOf(JSON.stringify({ openapi: "3.1.0", paths, components: { schemas: { W: wide(6_000) } } }))).toMatch(/too large once its references are followed/);
});

test("an allOf of one reference and thousands of parts of only words is gone through once", () => {
  const text = JSON.stringify({ openapi: "3.0.0", components: { schemas: { A: { type: "string" }, B: { allOf: [ref("A"), ...Array.from({ length: 20_000 }, () => ({}))] } } } });
  // How often a list as long as B's parts is searched: a few times, not once for each part.
  let searches = 0;
  const includes = Array.prototype.includes;
  const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (this: unknown[], ...args: Parameters<typeof includes>) {
    if (this.length >= 20_000) searches++;
    return includes.apply(this, args);
  });
  const result = readOpenApi(text);
  spy.mockRestore();
  if ("error" in result) throw new Error(result.error);
  expect(result.doc.types[1]!.schema).toEqual({ type: "A", ref: "B" });
  expect(result.doc.warnings).toEqual([]);
  expect(searches).toBeLessThan(5);
});

test("what's written beside a $ref applies in 3.1, and is ignored in 3.0", () => {
  const schemas = {
    User: { type: "object", description: "A person.", required: ["id"], properties: { id: { type: "string" }, name: { type: "string" } } },
    Code: { type: "string", minLength: 1 },
    Holder: {
      type: "object",
      properties: {
        // Only words: still the type, with the field's own description.
        owner: { $ref: "#/components/schemas/User", description: "Who owns it." },
        // More than words: the two together.
        admin: { $ref: "#/components/schemas/User", required: ["name"], properties: { role: { type: "string", enum: ["admin"] } }, example: { id: "1", name: "Ada", role: "admin" } },
        short: { $ref: "#/components/schemas/Code", maxLength: 5, enum: ["a", "b"] },
        // Itself with more: only named, and said so.
        twin: { $ref: "#/components/schemas/Holder", properties: { extra: { type: "string" } } },
      },
    },
  };
  const parts = { paths: { "/x": { get: { summary: "X", responses: { "200": json(ref("Holder")) } } } }, components: { schemas } };
  const user = [
    { name: "id", required: true, type: "string" },
    { name: "name", required: false, type: "string" },
  ];

  const later = read(JSON.stringify({ openapi: "3.1.0", info: { title: "T", version: "1" }, ...parts }));
  const response = later.operations[0]!.responses[0]!;
  expect(response.schema!.properties).toEqual([
    { name: "owner", required: false, type: "User", ref: "User", description: "Who owns it.", properties: user },
    {
      name: "admin",
      required: false,
      type: "object",
      description: "A person.",
      properties: [
        { name: "id", required: true, type: "string" },
        { name: "name", required: true, type: "string" },
        { name: "role", required: false, type: "string", enum: ["admin"] },
      ],
    },
    { name: "short", required: false, type: "string", constraints: "1–5 characters", enum: ["a", "b"] },
    { name: "twin", required: false, type: "Holder", ref: "Holder" },
  ]);
  expect(response.example).toEqual({ owner: { id: "string", name: "string" }, admin: { id: "1", name: "Ada", role: "admin" }, short: "a" });
  expect(codes(later)).toEqual(["ADDS_TO_ITSELF @ schemas › Holder › twin"]);

  // At the top of a response or a parameter, and as a part of an `allOf`, the same.
  const pet = { type: "object", example: { name: "Rex" }, properties: { name: { type: "string" } } };
  const top = (openapi: string) =>
    read(
      JSON.stringify({
        openapi,
        paths: {
          "/x": {
            get: {
              summary: "X",
              parameters: [{ name: "id", in: "query", schema: { $ref: "#/components/schemas/Id", example: "abc" } }],
              responses: {
                "200": json({ $ref: "#/components/schemas/Pet", example: { name: "Own" } }),
                "201": json({ $ref: "#/components/schemas/Pet", properties: { age: { type: "integer" } } }),
                "202": json(ref("Dog")),
              },
            },
          },
        },
        components: { schemas: { Pet: pet, Id: { type: "string", example: "id-1" }, Dog: { allOf: [{ $ref: "#/components/schemas/Pet", properties: { bark: { type: "boolean" } } }] } } },
      }),
    ).operations[0]!;
  const applied = top("3.1.0");
  expect(applied.params[0]!.example).toBe("abc");
  expect(applied.responses.map((one) => one.example)).toEqual([{ name: "Own" }, { name: "string", age: 0 }, { name: "string", bark: true }]);
  expect(applied.responses[2]!.schema).toEqual({
    type: "Dog",
    ref: "Dog",
    properties: [
      { name: "name", required: false, type: "string" },
      { name: "bark", required: false, type: "boolean" },
    ],
  });
  const ignored = top("3.0.3");
  expect(ignored.params[0]!.example).toBe("id-1");
  expect(ignored.responses.map((one) => one.example)).toEqual([{ name: "Rex" }, { name: "Rex" }, { name: "Rex" }]);
  expect(ignored.responses[2]!.schema).toMatchObject({ type: "Dog", ref: "Dog", properties: [{ name: "name", required: false, type: "string" }] });

  // And through a named schema that is itself a reference with more beside it.
  const through = (openapi: string) =>
    read(
      JSON.stringify({
        openapi,
        paths: { "/x": { get: { summary: "X", responses: { "200": json(ref("Admin")), "201": json(ref("Rex")), "202": json({ allOf: [ref("Admin"), { properties: { since: { type: "string" } } }] }) } } } },
        components: {
          schemas: {
            User: { type: "object", properties: { id: { type: "string" } } },
            Admin: { $ref: "#/components/schemas/User", properties: { role: { type: "string" } } },
            Pet: { type: "object", example: { name: "Any" }, properties: { name: { type: "string" } } },
            Rex: { $ref: "#/components/schemas/Pet", example: { name: "Rex" } },
          },
        },
      }),
    ).operations[0]!.responses;
  const [admin, rex, both] = through("3.1.0");
  expect(admin!.schema!.properties!.map((property) => property.name)).toEqual(["id", "role"]);
  expect(admin!.example).toEqual({ id: "string", role: "string" });
  expect(rex!.example).toEqual({ name: "Rex" });
  expect(both!.schema!.properties!.map((property) => property.name)).toEqual(["id", "role", "since"]);
  expect(both!.example).toEqual({ id: "string", role: "string", since: "string" });
  const [plain, any, fewer] = through("3.0.3");
  expect(plain!.schema!.properties!.map((property) => property.name)).toEqual(["id"]);
  expect(plain!.example).toEqual({ id: "string" });
  expect(any!.example).toEqual({ name: "Any" });
  expect(fewer!.schema!.properties!.map((property) => property.name)).toEqual(["id", "since"]);

  // `examples` and `$comment` are words too: the field is still the type. And a field that folds in the type it's inside, with words, stops there.
  const worded = (openapi: string) =>
    read(
      JSON.stringify({
        openapi,
        paths: {
          "/x": {
            get: {
              summary: "X",
              parameters: [{ $ref: "#/components/parameters/Page", description: "Which page here." }],
              responses: { "200": json(ref("Node")), "404": { $ref: "#/components/responses/NotFound", description: "No such post." } },
            },
          },
        },
        components: {
          securitySchemes: { key: { $ref: "#/components/securitySchemes/base", description: "Here." }, base: { type: "http", scheme: "bearer", description: "Base." } },
          parameters: { Page: { name: "page", in: "query", description: "Which page.", schema: { type: "integer" } } },
          responses: { NotFound: { description: "Not found." } },
          schemas: {
            User: { type: "object", properties: { id: { type: "string" } } },
            Node: {
              type: "object",
              properties: {
                owner: { $ref: "#/components/schemas/User", description: "Owner.", examples: [{ id: "u1" }], $comment: "Kept." },
                parent: { allOf: [{ $ref: "#/components/schemas/Node", description: "Its parent." }] },
                // Itself, with only words and a limit beside the reference: nothing added, so no warning.
                above: { $ref: "#/components/schemas/Node", description: "The one above.", readOnly: true },
              },
            },
          },
        },
      }),
    );
  const schemes = (openapi: string) => worded(openapi).auth.map((scheme) => scheme.description);
  expect(schemes("3.1.0")).toEqual(["Here.", "Base."]);
  expect(schemes("3.0.3")).toEqual(["Base.", "Base."]);
  const words31 = worded("3.1.0").operations[0]!;
  expect(words31.responses[0]!.schema!.properties).toEqual([
    { name: "owner", required: false, type: "User", ref: "User", description: "Owner.", properties: [{ name: "id", required: false, type: "string" }] },
    { name: "parent", required: false, type: "Node", ref: "Node", description: "Its parent." },
    { name: "above", required: false, type: "Node", ref: "Node", description: "The one above.", constraints: "read-only" },
  ]);
  expect(worded("3.1.0").warnings).toEqual([]);
  expect(words31.responses[0]!.example).toEqual({ owner: { id: "u1" } });
  // The description beside a reference to a parameter or a response is the one shown.
  expect(words31.params[0]!.description).toBe("Which page here.");
  expect(words31.responses[1]!.description).toBe("No such post.");
  const words30 = worded("3.0.3").operations[0]!;
  expect(words30.responses[0]!.example).toEqual({ owner: { id: "string" } });
  expect(words30.params[0]!.description).toBe("Which page.");
  expect(words30.responses[1]!.description).toBe("Not found.");

  // 3.0: a reference is only the reference, with the description beside it read as before.
  const earlier = spec(parts);
  const before = earlier.operations[0]!.responses[0]!;
  expect(before.schema!.properties).toEqual([
    { name: "owner", required: false, type: "User", ref: "User", description: "Who owns it.", properties: user },
    { name: "admin", required: false, type: "User", ref: "User", description: "A person.", properties: user },
    { name: "short", required: false, type: "Code", ref: "Code", constraints: "at least 1 character" },
    { name: "twin", required: false, type: "Holder", ref: "Holder" },
  ]);
  expect(before.example).toEqual({ owner: { id: "string", name: "string" }, admin: { id: "string", name: "string" }, short: "string" });
  expect(earlier.warnings).toEqual([]);
});

test("a long allOf of parts written one by one is listed once, not copied for each part", () => {
  const text = JSON.stringify({ openapi: "3.0.0", components: { schemas: { A: { allOf: Array.from({ length: 1_500 }, (_, index) => (index === 0 ? { type: "object", properties: { id: { type: "string" } } } : {})) } } } });
  // How often a long list is put into a map: a copy of the parts so far for each part would be a thousand of them.
  let copies = 0;
  const set = Map.prototype.set;
  const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (Array.isArray(value) && value.length >= 500) copies++;
    return set.call(this, key, value);
  });
  const result = readOpenApi(text);
  spy.mockRestore();
  if ("error" in result) throw new Error(result.error);
  expect(result.doc.types[0]!.schema).toEqual({ type: "object", ref: "A", properties: [{ name: "id", required: false, type: "string" }] });
  expect(copies).toBeLessThan(5);
});

test("a schema or parameter with thousands of other keys has them listed once, not on every use", () => {
  const junk = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`x-${index}`, 1]));
  const wide = { "x-wide": true, ...junk, type: "string", description: "Wide." };
  const param = { "x-wide": true, ...junk, name: "q", in: "query", example: "e", schema: { type: "string" } };
  const fields = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`f${index}`, index % 2 ? ref("W") : { allOf: [ref("W"), { type: "string", maxLength: 5 }] }]));
  const text = JSON.stringify({
    openapi: "3.0.0",
    paths: { "/a": { get: { summary: "A", parameters: Array.from({ length: 150 }, () => ({ $ref: "#/components/parameters/P" })), responses: { "200": json({ type: "object", properties: fields }) } } } },
    components: { schemas: { W: wide }, parameters: { P: param } },
  });
  let listings = 0;
  const wideOnes = (value: unknown) => typeof value === "object" && value !== null && Object.hasOwn(value, "x-wide");
  const keys = Object.keys;
  const all = Object.entries;
  const listedKeys = vi.spyOn(Object, "keys").mockImplementation((value: object) => {
    if (wideOnes(value)) listings++;
    return keys(value);
  });
  const listedEntries = vi.spyOn(Object, "entries").mockImplementation((value: object) => {
    if (wideOnes(value)) listings++;
    return all(value);
  });
  const result = readOpenApi(text);
  listedKeys.mockRestore();
  listedEntries.mockRestore();
  if ("error" in result) throw new Error(result.error);
  const [get] = result.doc.operations;
  expect(get!.params).toEqual([{ name: "q", in: "query", required: false, description: "", schema: { type: "string" }, example: "e" }]);
  const [folded, named] = get!.responses[0]!.schema!.properties!;
  // Folded in, a wide schema gives its keywords and none of its other keys.
  expect(folded).toEqual({ name: "f0", required: false, type: "string", description: "Wide.", constraints: "at most 5 characters" });
  expect(named).toEqual({ name: "f1", required: false, type: "W", ref: "W", description: "Wide." });
  // W's keys once (what it says), P's never: nothing is listed per use.
  expect(listings).toBeLessThanOrEqual(2);
});

test("a reference's fragment is percent-decoded, then split, then its parts unescaped", () => {
  const { schema, doc } = schemaOf(
    {
      type: "object",
      properties: {
        encodedTilde: { $ref: "#/components/schemas/a%7E1b" },
        tilde: { $ref: "#/components/schemas/a~1b" },
        space: { $ref: "#/components/schemas/User%20Response" },
        // An encoded slash is a separator like any other: this is `a`, then `b`.
        slash: { $ref: "#/components/schemas/a%2Fb" },
        literalTilde: { $ref: "#/components/schemas/c~0d" },
        stray: { $ref: "#/components/schemas/100%" },
      },
    },
    { "a/b": { type: "integer" }, "User Response": { type: "boolean" }, "c~d": { type: "string" }, "100%": { type: "number" } },
  );
  expect(schema.properties!.map((property) => [property.name, property.type])).toEqual([
    ["encodedTilde", "a/b"],
    ["tilde", "a/b"],
    ["space", "User Response"],
    ["slash", "object"],
    ["literalTilde", "c~d"],
    ["stray", "100%"],
  ]);
  expect(codes(doc)).toEqual(["UNKNOWN_REF @ GET /x › responses › 200 › slash"]);
});

test("a name longer than a name is refuses the spec, saying which", () => {
  const long = (most: number) => "n".repeat(most + 1);
  const ok = (most: number) => "n".repeat(most);
  const get = (operation: object = {}) => ({ get: { summary: "S", responses: {}, ...operation } });
  // What it's called, the most it may be, and a spec with `name` there.
  const cases: [string, number, (name: string) => object][] = [
    ["a path", 500, (name) => ({ paths: { [name.replace(/^n/, "/")]: get() } })],
    ["a path", 500, (name) => ({ paths: { [name]: get() } })],
    ["a parameter's name", 256, (name) => ({ paths: { "/a": get({ parameters: [{ name, in: "query" }] }) } })],
    ["a schema's name", 256, (name) => ({ components: { schemas: { [name]: { type: "string" } } } })],
    ["a field's name", 256, (name) => ({ components: { schemas: { A: { type: "object", properties: { [name]: {} } } } } })],
    ["a tag", 256, (name) => ({ paths: { "/a": get({ tags: [name] }) } })],
    ["a tag", 256, (name) => ({ tags: [{ name }] })],
    ["a security scheme's name", 256, (name) => ({ components: { securitySchemes: { [name]: { type: "http", scheme: "bearer" } } } })],
    ["a security scheme's name", 256, (name) => ({ security: [{ [name]: [] }], paths: { "/a": get() } })],
    ["a security scheme's header, query or cookie name", 256, (name) => ({ components: { securitySchemes: { k: { type: "apiKey", in: "header", name } } } })],
    ["a response's status", 256, (name) => ({ paths: { "/a": get({ responses: { [name]: {} } }) } })],
    ["an operationId", 256, (name) => ({ paths: { "/a": { get: { operationId: name, responses: {} } } } })],
    ["a content type", 256, (name) => ({ paths: { "/a": get({ responses: { "200": { content: { [name]: {} } } } }) } })],
    ["a format", 256, (name) => ({ components: { schemas: { A: { type: "string", format: name } } } })],
    ["a version", 256, (name) => ({ info: { title: "T", version: name } })],
    ["a server's address", 2_000, (name) => ({ servers: [{ url: name.replace(/^n{8}/, "https://") }] })],
    ["a reference", 2_000, (name) => ({ components: { schemas: { A: { type: "object", properties: { a: { $ref: name.replace(/^n{8}/, "https://") } } } } } })],
    ["a server variable's name", 256, (name) => ({ servers: [{ url: "https://{v}", variables: { [name]: { default: "a" } } }] })],
    ["a server variable's value", 256, (name) => ({ servers: [{ url: "https://{v}", variables: { v: { default: name } } }] })],
  ];
  const text = (parts: object) => JSON.stringify({ openapi: "3.0.3", info: { title: "T", version: "1" }, ...parts });
  for (const [what, most, parts] of cases) {
    const refused = errorOf(text(parts(long(most))));
    expect(refused).toMatch(new RegExp(`^This spec has ${what} over ${most.toLocaleString("en").replace(",", "")} characters long, starting "(/|https://)?n+"\\. Shorten it and try again\\.$`));
    expect(refused!.length).toBeLessThan(200);
    expect(errorOf(text(parts(ok(most))))).toBeNull();
  }
  // The start of the name, never half of a pair.
  expect(errorOf(text({ components: { schemas: { [`${"n".repeat(39)}😀${"n".repeat(300)}`]: {} } } }))).toBe(`This spec has a schema's name over 256 characters long, starting "${"n".repeat(39)}". Shorten it and try again.`);
});

test("text that's copied is cut at its length, with a warning for the place", () => {
  const long = (most: number, tail = "tail") => `${"t".repeat(most)}${tail}`;
  const doc = spec({
    info: { title: long(2_000), version: "1", description: long(50_000) },
    tags: [{ name: "Tagged", description: long(50_000) }],
    servers: [{ url: "https://{v}.example.com", description: long(50_000), variables: { v: { default: "a", description: long(50_000) } } }],
    paths: {
      "/a": {
        get: {
          summary: long(2_000),
          description: long(50_000),
          tags: ["Tagged"],
          parameters: [{ name: "q", in: "query", description: long(50_000), example: long(50_000), schema: { type: "string", pattern: long(2_000), default: long(50_000), enum: ["a", long(50_000)] } }],
          requestBody: json({ type: "object", description: long(50_000), properties: { deep: { type: "string", description: long(50_000) } } }, { example: { nested: [long(50_000), "short"] } }),
          responses: { "200": { description: long(50_000), ...json({ type: "string", example: long(50_000) }) } },
        },
      },
    },
    components: { securitySchemes: { key: { type: "http", scheme: "bearer", description: long(50_000) } } },
  });
  const [get] = doc.operations;
  const text = "t".repeat(50_000);
  const line = "t".repeat(2_000);
  expect(doc).toMatchObject({ title: line, description: text, groups: [{ description: text }], auth: [{ description: text }] });
  expect(doc.servers[0]).toEqual({ url: "https://{v}.example.com", description: text, variables: { v: { default: "a", description: text } } });
  expect(get).toMatchObject({ title: line, description: text });
  expect(get!.params[0]).toEqual({
    name: "q",
    in: "query",
    required: false,
    description: text,
    example: text,
    schema: { type: "string", constraints: `matches ${line}`, default: text, enum: ["a", text] },
  });
  expect(get!.body).toMatchObject({ schema: { description: text, properties: [{ name: "deep", description: text }] }, example: { nested: [text, "short"] } });
  expect(get!.responses[0]).toMatchObject({ description: text, example: text });
  // One per place, however many texts there were cut.
  expect(codes(doc)).toEqual([
    "TEXT_CUT @ securitySchemes › key",
    "TEXT_CUT @ GET /a",
    "TEXT_CUT @ GET /a › parameters › q",
    "TEXT_CUT @ GET /a › body",
    "TEXT_CUT @ GET /a › body › deep",
    "TEXT_CUT @ GET /a › responses › 200",
    "TEXT_CUT @ tags › Tagged",
    "TEXT_CUT @ info › title",
    "TEXT_CUT @ info › description",
    "TEXT_CUT @ servers",
  ]);

  // A text exactly as long as it may be is whole, and a cut never leaves half of a pair.
  const whole = spec({ info: { title: "T", version: "1", description: "t".repeat(50_000) } });
  expect(whole.description).toHaveLength(50_000);
  expect(whole.warnings).toEqual([]);
  const pair = spec({ info: { title: `${"t".repeat(1_999)}😀tail`, version: "1", description: `${"t".repeat(49_999)}😀tail` } });
  expect(pair.title).toBe("t".repeat(1_999));
  expect(pair.description).toBe("t".repeat(49_999));
  expect(spec({ info: { title: `${"t".repeat(1_998)}😀tail`, version: "1" } }).title).toBe(`${"t".repeat(1_998)}😀`);
});

test("a warning's place and a type's words stay short, however deep or often", () => {
  // Names as long as names may be, nested deep: the place stops growing.
  const name = "f".repeat(256);
  const nest = (levels: number): object => (levels === 0 ? { $ref: "#/components/schemas/Gone" } : { type: "object", properties: { [name]: nest(levels - 1) } });
  const array = (levels: number): object => (levels === 0 ? { type: "string" } : { type: "array", items: array(levels - 1) });
  const { schema, doc } = schemaOf({ type: "object", properties: { deep: nest(40), lists: array(60), many: { oneOf: Array.from({ length: 30 }, (_, index) => ({ type: "object", title: `T${index}`, properties: { [`p${index}`]: ref(`S${index}`) } })) } } }, Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`S${"s".repeat(200)}${index}`, { type: "string" }])));
  const [warning] = doc.warnings.filter((one) => one.code === "UNKNOWN_REF" && one.where.includes("deep"));
  expect(warning!.where.length).toBeLessThan(1_000 + 260);
  const lists = schema.properties![1]!;
  expect(lists.type).toHaveLength(301);
  expect(lists.type.endsWith("…")).toBe(true);
  expect(lists.type.startsWith("array of array of ")).toBe(true);

  // The case that grew without end: an unknown scheme named in every operation's warning.
  const paths = Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`/${index}`, { get: {} }]));
  expect(errorOf(JSON.stringify({ openapi: "3.0.0", security: [{ ["s".repeat(400_000)]: [] }], paths }))).toMatch(/^This spec has a security scheme's name over 256 characters long/);
  const longest = spec({ security: [{ ["s".repeat(256)]: [] }], paths });
  expect(longest.warnings).toHaveLength(6_000);
  expect(longest.warnings.reduce((sum, one) => sum + one.where.length, 0)).toBeLessThan(6_000 * 300);
});

test("a spec that's too large once read is an error", () => {
  const paths = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`/p${index}`, { get: { summary: `P${index}`, responses: { "200": json({ type: "string" }, { examples: { one: { $ref: "#/components/examples/Big" } } }) } } }]),
  );
  const big = Array.from({ length: 50 }, () => "x".repeat(40_000));
  const text = JSON.stringify({ openapi: "3.0.0", paths, components: { examples: { Big: { value: big } } } });
  expect(text.length).toBeLessThan(2_100_000);
  expect(errorOf(text)).toMatch(/too large once its references are followed/);
});

test("servers: a relative address is kept as written, with a warning; none is none", () => {
  const doc = spec({
    servers: [{ url: "/v1" }, { url: "https://api.example.com" }, { url: "{scheme}://api.example.com", variables: { scheme: { default: "https" } } }, { url: "v2", description: "Beta" }, { description: "No address." }],
    paths: { "/a": { get: { summary: "A", servers: [{ url: "/files" }], responses: {} } } },
  });
  expect(doc.servers).toEqual([
    { url: "/v1", description: "" },
    { url: "https://api.example.com", description: "" },
    { url: "{scheme}://api.example.com", description: "", variables: { scheme: { default: "https", description: "" } } },
    { url: "v2", description: "Beta" },
  ]);
  expect(doc.operations[0]!.servers).toEqual([{ url: "/files", description: "" }]);
  expect(codes(doc)).toEqual(["RELATIVE_SERVER @ GET /a › servers › /files", "RELATIVE_SERVER @ servers › /v1", "RELATIVE_SERVER @ servers › v2"]);

  const port = read("openapi: 3.0.0\nservers:\n  - url: https://api.example.com:{port}\n    variables:\n      port: { default: 8443, enum: [8443, 443] }\n");
  expect(port.servers).toEqual([{ url: "https://api.example.com:{port}", description: "", variables: { port: { default: "8443", enum: ["8443", "443"], description: "" } } }]);

  const none = spec({ paths: { "/a": { get: { summary: "A", responses: {} } } } });
  expect(none.servers).toEqual([]);
  expect(none.warnings).toEqual([]);
  expect(none.operations[0]).not.toHaveProperty("servers");
});

test("many operations that each spell out one wide schema stop the read early", () => {
  const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`f${index}`, { type: "string" }])) };
  const paths = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`/${index}`, { get: { responses: { "200": { $ref: "#/components/responses/R" } } } }]));
  const text = JSON.stringify({ openapi: "3.0.0", paths, components: { responses: { R: json(ref("S")) }, schemas: { S: wide } } });
  expect(errorOf(text, { values: 20_000 })).toMatch(/too large once its references are followed/);
  expect(errorOf(text)).toBeNull();
});

test("what's left out is warned about", () => {
  const doc = spec({
    webhooks: { created: { post: { responses: {} } } },
    paths: { "/a": { post: { summary: "A", callbacks: { done: {} }, responses: {} } }, "users/{id}": { get: { summary: "B", responses: {} } }, "x-internal": {} },
  });
  expect(doc.operations).toHaveLength(1);
  expect(doc.warnings).toEqual([
    { code: "CALLBACKS_SKIPPED", message: "An operation's callbacks were left out.", where: "POST /a" },
    { code: "PATH_SKIPPED", message: "A path doesn't start with a slash, so it and its operations were left out.", where: "users/{id}" },
    { code: "WEBHOOKS_SKIPPED", message: "The spec's webhooks were left out.", where: "webhooks" },
  ]);
  for (const warning of doc.warnings) expect(warning.code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
});
