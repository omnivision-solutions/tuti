import { expect, test } from "vitest";

import { tryable, tryAuth, type TryInput, tryRequest, tryServers } from "./try";
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
