import { expect, test } from "vitest";

import { readUpTo, shownUrl, tryable, tryAuth, type TryForm, tryInput, type TryInput, tryParams, tryRequest, tryServers } from "./try";
import type { ApiDoc, ApiOperation } from "./types";

const doc = (over: Partial<ApiDoc> = {}): ApiDoc => ({
  format: "openapi",
  title: "Acme",
  version: "1",
  description: "",
  servers: [{ url: "https://api.acme.test/v1", description: "" }],
  auth: [
    { key: "bearer", kind: "bearer", name: "Authorization", description: "" },
    { key: "query", kind: "query", name: "api_key", description: "" },
    { key: "mtls", kind: "header", name: "X-Mtls", description: "" },
  ],
  groups: [],
  operations: [],
  types: [],
  warnings: [],
  ...over,
});

const operation = (over: Partial<ApiOperation> = {}): ApiOperation => ({
  key: "GET /posts/{}",
  slug: "get-a-post",
  group: "posts",
  kind: "GET",
  path: "/posts/{id}",
  title: "Get a post",
  description: "",
  deprecated: false,
  auth: [["query"]],
  params: [{ name: "id", in: "path", required: true, description: "", schema: { type: "string" } }],
  body: null,
  responses: [],
  ...over,
});

const input = (over: Partial<TryInput> = {}): TryInput => ({
  server: "https://api.acme.test/v1",
  variables: {},
  path: { id: "1" },
  query: [],
  headers: [],
  cookies: [],
  body: null,
  ...over,
});

test("Try it is on only for OpenAPI with a server that names a host, or the reference's base address", () => {
  expect(tryable(doc(), operation(), null)).toBe(true);
  expect(tryable(doc({ format: "graphql" }), operation(), null)).toBe(false);
  expect(tryable(doc(), operation({ kind: "TRACE" }), null)).toBe(false);
  // All relative, no base: nowhere to send it.
  expect(tryable(doc({ servers: [{ url: "/v1", description: "" }] }), operation(), null)).toBe(false);
  expect(tryServers(doc({ servers: [{ url: "/v1", description: "" }] }), operation(), "https://acme.test/?tenant=a")).toEqual([{ url: "https://acme.test/v1?tenant=a", description: "" }]);
  expect(tryServers(doc({ servers: [] }), operation(), null)).toEqual([]);
  expect(tryServers(doc({ servers: [] }), operation(), "https://acme.test")).toEqual([{ url: "https://acme.test", description: "" }]);
  // A variable's default can make one have a host.
  expect(tryServers(doc({ servers: [{ url: "{scheme}://acme.test", description: "", variables: { scheme: { default: "https", description: "" } } }] }), operation(), null)).toHaveLength(1);
  // An operation's own servers come first.
  expect(tryServers(doc(), operation({ servers: [{ url: "https://uploads.acme.test", description: "" }] }), null).map((s) => s.url)).toEqual(["https://uploads.acme.test"]);
});

test("asks for the key of the first way of signing whose schemes are all known, and says when none is needed", () => {
  expect(tryAuth(doc(), operation())).toEqual({ schemes: [doc().auth[1]], optional: false });
  expect(tryAuth(doc(), operation({ auth: [["ghost", "bearer"], ["bearer"], []] }))).toEqual({ schemes: [doc().auth[0]], optional: true });
  expect(tryAuth(doc(), operation({ auth: [] }))).toEqual({ schemes: [], optional: true });
});

test("makes the request: variables and path parameters encoded, a GET without a body", () => {
  const made = tryRequest(doc({ servers: [{ url: "https://{region}.acme.test/v1", description: "", variables: { region: { default: "eu", description: "" } } }] }), operation(), null, {
    ...input({ server: "https://{region}.acme.test/v1", path: { id: "a/b c" }, query: [["api_key", "k 1"]], body: "ignored" }),
  });
  expect(made).toMatchObject({ method: "GET", body: null, headers: [] });
  expect("url" in made && made.url.href).toBe("https://eu.acme.test/v1/posts/a%2Fb%20c?api_key=k+1");
  // A value of a variable can't add a path, a user or a fragment to the host.
  const server = { url: "https://{region}.acme.test/v1", description: "", variables: { region: { default: "eu", description: "" } } };
  for (const region of ["evil.example/x", "evil.example@", "evil.example#"]) {
    expect(tryRequest(doc({ servers: [server] }), operation(), null, input({ server: server.url, variables: { region } }))).toHaveProperty("error");
  }
});

test("refuses what the operation doesn't take", () => {
  const post = operation({ kind: "POST", body: { required: false, contentType: "application/json", schema: { type: "object" }, example: {} } });
  expect(tryRequest(doc(), post, null, input({ headers: [["Content-Type", "application/json"]], body: "{}" }))).toMatchObject({ body: "{}" });
  expect(tryRequest(doc(), post, null, input({ body: "x".repeat(1_000_001) }))).toEqual({ error: "The body is over 1 MB" });
  expect(tryRequest(doc(), operation(), null, input({ path: {} }))).toEqual({ error: "Fill in id" });
  expect(tryRequest(doc(), operation(), null, input({ path: { id: "." } }))).toEqual({ error: "Fill in id" });
  expect(tryRequest(doc(), operation(), null, input({ server: "https://evil.example" }))).toEqual({ error: "Pick one of the API's servers" });
  // The key's header only for a scheme the operation is signed with: this one's goes in the query.
  expect(tryRequest(doc(), operation(), null, input({ headers: [["Authorization", "x"]] }))).toHaveProperty("error");
  expect(tryRequest(doc(), operation(), null, input({ cookies: [["session", "x"]] }))).toHaveProperty("error");
  // A connection's own header, even when the spec names it a parameter.
  const host = operation({ params: [...operation().params, { name: "Host", in: "header", required: false, description: "", schema: { type: "string" } }] });
  expect(tryRequest(doc(), host, null, input({ headers: [["Host", "evil.example"]] }))).toHaveProperty("error");
});

test("a server's own values (its default, one of its allowed values) go in as they are; the same for the check and the request", () => {
  const whole = { url: "{baseUrl}", description: "", variables: { baseUrl: { default: "https://api.acme.test", enum: ["https://api.acme.test", "https://eu.acme.test/v2"], description: "" } } };
  const spec = doc({ servers: [whole] });
  expect(tryable(spec, operation(), null)).toBe(true);
  const sent = (variables: Record<string, string>) => {
    const made = tryRequest(spec, operation(), null, input({ server: "{baseUrl}", variables }));
    return "url" in made ? made.url.href : made.error;
  };
  expect(sent({})).toBe("https://api.acme.test/posts/1");
  expect(sent({ baseUrl: "https://eu.acme.test/v2" })).toBe("https://eu.acme.test/v2/posts/1");
  // Anything else the reader types is encoded: never an address of its own.
  expect(sent({ baseUrl: "https://evil.example" })).toBe("The server's address isn't valid");
  // A default with a slash stays a path.
  const path = { url: "https://api.acme.test/{basePath}", description: "", variables: { basePath: { default: "v1/beta", description: "" } } };
  const made = tryRequest(doc({ servers: [path] }), operation(), null, input({ server: path.url }));
  expect("url" in made && made.url.href).toBe("https://api.acme.test/v1/beta/posts/1");
});

test("slashes are trimmed where the server's path meets the operation's, however many", () => {
  const made = tryRequest(doc({ servers: [{ url: `https://api.acme.test/v1${"/".repeat(50_000)}`, description: "" }] }), operation({ path: `${"/".repeat(50_000)}posts/{id}` }), null, input({ server: `https://api.acme.test/v1${"/".repeat(50_000)}` }));
  expect("url" in made && made.url.href).toBe("https://api.acme.test/v1/posts/1");
});

const form = (over: Partial<TryForm> = {}): TryForm => ({ server: "https://api.acme.test/v1", variables: {}, params: { "path:id": "1" }, keys: {}, body: "", ...over });
const header = (name: string) => ({ name, in: "header" as const, required: true, description: "", schema: { type: "string" } });

test("the console asks for path, query and header parameters, but not the headers the key and body set, nor a connection's", () => {
  const op = operation({ params: [...operation().params, header("Authorization"), header("Accept"), header("Content-Type"), header("X-Forwarded-For"), header("X-Team")] });
  expect(tryParams(doc(), op).map((param) => param.name)).toEqual(["id", "X-Team"]);
});

test("a parameter named like where the key goes isn't asked for: the key takes its place, not beside it", () => {
  const keyed = doc({ auth: [{ key: "key", kind: "header", name: "X-Key", description: "" }, ...doc().auth] });
  const params = [...operation().params, header("x-key"), { name: "api_key", in: "query" as const, required: true, description: "", schema: { type: "string" } }];
  expect(tryParams(keyed, operation({ auth: [["key"]], params })).map((param) => param.name)).toEqual(["id", "api_key"]);
  expect(tryParams(keyed, operation({ auth: [["query"]], params })).map((param) => param.name)).toEqual(["id", "x-key"]);
  // Prefilled as the examples would be, the parameter still goes nowhere: the key alone is sent.
  const input = tryInput(keyed, operation({ auth: [["key"]], params }), form({ params: { "path:id": "1", "header:x-key": "string" }, keys: { key: "sk_1" } }));
  expect(input.headers).toEqual([["X-Key", "sk_1"]]);
});

test("an answer is read up to its limit in bytes, the rest cancelled; a character cut in two is left off", async () => {
  let cancelled = false;
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
      cancel() {
        cancelled = true;
      },
    });
  // "é" is two bytes: four of them are eight, and the limit (7) cuts the last in two.
  expect(await readUpTo(stream(["éé", "éé", "never read"]), 7)).toEqual({ text: "ééé", size: 7, cut: true });
  expect(cancelled).toBe(true);
  expect(await readUpTo(stream(["ab", "c"]), 7)).toEqual({ text: "abc", size: 3, cut: false });
  expect(await readUpTo(null, 7)).toEqual({ text: "", size: 0, cut: false });
});

test("the key goes where its scheme puts it; Basic is the username and password in base64 of UTF-8", () => {
  const schemes = doc({
    auth: [
      { key: "basic", kind: "basic", name: "Authorization", description: "" },
      { key: "cookie", kind: "cookie", name: "session", description: "" },
    ],
  });
  const basic = tryInput(schemes, operation({ auth: [["basic"]] }), form({ keys: { "basic:user": "zoë", "basic:password": "p:w" } }));
  expect(basic.headers).toEqual([["Authorization", `Basic ${Buffer.from("zoë:p:w").toString("base64")}`]]);
  expect(tryInput(schemes, operation({ auth: [["cookie"]] }), form({ keys: { cookie: "abc" } })).cookies).toEqual([["session", "abc"]]);
  // No key typed: none sent.
  expect(tryInput(schemes, operation({ auth: [["cookie"]] }), form()).cookies).toEqual([]);
  // The body's type goes with a body only.
  const post = operation({ kind: "POST", body: { required: true, contentType: "application/json", schema: { type: "object" }, example: {} } });
  expect(tryInput(doc(), post, form({ body: "{}" })).headers).toContainEqual(["Content-Type", "application/json"]);
  expect(tryInput(doc(), post, form({ body: "" })).headers).toEqual([]);
});

test("an array query parameter is sent once per item and an object one per field, as the examples show them", () => {
  const op = operation({
    params: [
      ...operation().params,
      { name: "ids", in: "query", required: false, description: "", schema: { type: "array of integer", items: { type: "integer" } } },
      { name: "filter", in: "query", required: false, description: "", schema: { type: "object", properties: [{ name: "status", required: false, type: "string" }] } },
    ],
  });
  const input = tryInput(doc(), op, form({ params: { "path:id": "1", "query:ids": "1, 2", "query:filter": '{"status":"open"}' } }));
  expect(input.query).toEqual([["ids", "1"], ["ids", "2"], ["status", "open"]]);
  // And sent so: the object's fields are its names.
  const made = tryRequest(doc(), op, null, input);
  expect("url" in made && made.url.search).toBe("?ids=1&ids=2&status=open");
  expect(tryRequest(doc(), op, null, { ...input, query: [["other", "1"]] })).toHaveProperty("error");
  // An object that lists no fields takes any name.
  const open = operation({ params: [...operation().params, { name: "filter", in: "query", required: false, description: "", schema: { type: "object" } }] });
  expect(tryRequest(doc(), open, null, { ...input, query: [["anything", "1"]] })).not.toHaveProperty("error");
});

test("a key in the query is hidden in the address shown", () => {
  const made = tryRequest(doc(), operation(), null, input({ query: [["api_key", "sk_live_1"]] }));
  expect("url" in made && shownUrl(doc(), operation(), made)).toBe("https://api.acme.test/v1/posts/1?api_key=****");
});

test("a header or cookie with a character beyond Latin-1 is refused before sending, by name: a browser couldn't send it", () => {
  const team = operation({ params: [...operation().params, header("X-Team")] });
  expect(tryRequest(doc(), team, null, input({ headers: [["X-Team", "café–beta"]] }))).toEqual({ error: "X-Team has a character a request can't carry in a header: –" });
  // Latin-1 itself is fine ("é").
  expect(tryRequest(doc(), team, null, input({ headers: [["X-Team", "café"]] }))).not.toHaveProperty("error");
  const cookie = doc({ auth: [{ key: "cookie", kind: "cookie", name: "session", description: "" }] });
  expect(tryRequest(cookie, operation({ auth: [["cookie"]] }), null, input({ cookies: [["session", "it’s"]] }))).toEqual({ error: "session has a character a request can't carry in a header: ’" });
});
