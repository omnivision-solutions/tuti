import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { exampleRequest, requestExamples } from "./examples";
import type { ApiAuth, ApiDoc, ApiOperation, ApiParam } from "./types";

function doc(over: Partial<ApiDoc> = {}): ApiDoc {
  return {
    format: "openapi",
    title: "Acme",
    version: "1",
    description: "",
    servers: [{ url: "https://api.acme.test/v1", description: "" }],
    auth: [],
    groups: [],
    operations: [],
    types: [],
    warnings: [],
    ...over,
  };
}

function operation(over: Partial<ApiOperation> = {}): ApiOperation {
  return {
    key: "GET /posts",
    slug: "list-posts",
    group: "posts",
    kind: "GET",
    path: "/posts",
    title: "List posts",
    description: "",
    deprecated: false,
    auth: [],
    params: [],
    body: null,
    responses: [],
    ...over,
  };
}

function param(over: Partial<ApiParam> & Pick<ApiParam, "name" | "in">): ApiParam {
  return { required: true, description: "", schema: { type: "string" }, ...over };
}

function auth(kind: ApiAuth["kind"], name = "Authorization"): ApiAuth {
  return { key: kind, kind, name, description: "" };
}

function body(example: unknown, contentType = "application/json"): ApiOperation["body"] {
  return { required: true, contentType, schema: { type: "object" }, example };
}

/** Everything a shell, JavaScript or Python could take for its own. */
const NASTY = "it's \"quoted\" \\ $HOME `id` ${x} $(id)\nsecond line\ttab é 日本 @end";

describe("exampleRequest: where it goes", () => {
  it("puts a server without a host on the placeholder's, so the example can be run", () => {
    expect(exampleRequest(doc({ servers: [{ url: "/api/v3", description: "" }] }), operation()).url).toBe("https://api.example.com/api/v3/posts");
    expect(exampleRequest(doc({ servers: [{ url: "v1", description: "" }] }), operation()).url).toBe("https://api.example.com/v1/posts");
    expect(exampleRequest(doc({ servers: [{ url: "./v1", description: "" }] }), operation()).url).toBe("https://api.example.com/v1/posts");
    expect(exampleRequest(doc({ servers: [{ url: ".", description: "" }] }), operation()).url).toBe("https://api.example.com/posts");
    expect(exampleRequest(doc({ servers: [{ url: "//api.acme.test/v1", description: "" }] }), operation()).url).toBe("https://api.acme.test/v1/posts");
    // The one asked for is used as it is: a console may send to its own origin.
    expect(exampleRequest(doc(), operation(), { server: "/proxy" }).url).toBe("/proxy/posts");
  });

  it("puts a server without a host, or no server, on the base it's given, and leaves a server with a host alone", () => {
    const base = "https://acme.test/";
    expect(exampleRequest(doc({ servers: [{ url: "/api/v3", description: "" }] }), operation(), { base }).url).toBe("https://acme.test/api/v3/posts");
    expect(exampleRequest(doc({ servers: [{ url: ".", description: "" }] }), operation(), { base }).url).toBe("https://acme.test/posts");
    expect(exampleRequest(doc({ servers: [] }), operation(), { base }).url).toBe("https://acme.test/posts");
    expect(exampleRequest(doc(), operation(), { base }).url).toBe("https://api.acme.test/v1/posts");
  });

  it("joins a server and a path with one slash, however many either has", () => {
    const many = "/".repeat(5000);
    expect(exampleRequest(doc({ servers: [{ url: `https://api.acme.test${many}`, description: "" }] }), operation({ path: `${many}posts` })).url).toBe("https://api.acme.test/posts");
  });

  it("uses the doc's first server, else a placeholder, else the one asked for", () => {
    expect(exampleRequest(doc(), operation()).url).toBe("https://api.acme.test/v1/posts");
    expect(exampleRequest(doc({ servers: [] }), operation()).url).toBe("https://api.example.com/posts");
    expect(exampleRequest(doc(), operation(), { server: "http://localhost:3000" }).url).toBe("http://localhost:3000/posts");
    const own = operation({ servers: [{ url: "https://uploads.acme.test", description: "" }] });
    expect(exampleRequest(doc(), own).url).toBe("https://uploads.acme.test/posts");
    expect(exampleRequest(doc(), own, { server: "http://localhost:3000" }).url).toBe("http://localhost:3000/posts");
  });

  it("fills a spec's server's variables with their defaults, and leaves a server asked for as it is", () => {
    const servers = [
      {
        url: "https://{region}.acme.test:{port}/{version}/{other}",
        description: "",
        variables: { region: { default: "eu", enum: ["eu", "us"], description: "" }, port: { default: "8443", description: "" } },
      },
    ];
    expect(exampleRequest(doc({ servers }), operation()).url).toBe("https://eu.acme.test:8443/{version}/{other}/posts");
    expect(exampleRequest(doc(), operation({ servers })).url).toBe("https://eu.acme.test:8443/{version}/{other}/posts");
    expect(exampleRequest(doc({ servers }), operation(), { server: "https://{region}.acme.test" }).url).toBe("https://{region}.acme.test/posts");
  });

  it("joins the server and the path with one slash", () => {
    const url = (server: string, path: string) => exampleRequest(doc(), operation({ path }), { server }).url;
    expect(url("https://a.test/", "/posts")).toBe("https://a.test/posts");
    expect(url("https://a.test", "posts")).toBe("https://a.test/posts");
    expect(url("https://a.test/v1//", "//posts")).toBe("https://a.test/v1/posts");
  });

  it("fills path parameters from their example, else their schema's type, else leaves them", () => {
    const request = exampleRequest(
      doc(),
      operation({
        path: "/a/{withExample}/{integer}/{string}/{flag}/{choice}/{level}/{object}/{unknown}",
        params: [
          param({ name: "withExample", in: "path", example: "a b/c" }),
          param({ name: "integer", in: "path", schema: { type: "integer" } }),
          param({ name: "string", in: "path" }),
          param({ name: "flag", in: "path", schema: { type: "boolean" } }),
          param({ name: "choice", in: "path", schema: { type: "string", enum: ["open", "closed"] } }),
          param({ name: "level", in: "path", schema: { type: "integer", enum: [3, 5] } }),
          param({ name: "object", in: "path", schema: { type: "Post" } }),
        ],
      }),
    );
    expect(request.url).toBe("https://api.acme.test/v1/a/a%20b%2Fc/1/string/true/open/3/{object}/{unknown}");
  });

  it("appends required query parameters, encoded, and leaves optional ones out", () => {
    const request = exampleRequest(
      doc(),
      operation({
        params: [
          param({ name: "q", in: "query", example: "a&b=c d" }),
          param({ name: "tag[]", in: "query", example: ["x", "y z"] }),
          param({ name: "limit", in: "query", schema: { type: "integer", default: 20 } }),
          param({ name: "filter", in: "query", schema: { type: "Filter" } }),
          param({ name: "page", in: "query", required: false, example: 2 }),
          param({ name: "range", in: "query", example: { from: "2026-01-01", to: "2026-02-01" } }),
        ],
      }),
    );
    expect(request.url).toBe("https://api.acme.test/v1/posts?q=a%26b%3Dc%20d&tag%5B%5D=x&tag%5B%5D=y%20z&limit=20&filter={filter}&from=2026-01-01&to=2026-02-01");
  });

  it("sends required header parameters as headers", () => {
    const request = exampleRequest(
      doc(),
      operation({
        params: [
          param({ name: "X-Version", in: "header", example: "2026-01-01" }),
          param({ name: "X-Trace", in: "header", required: false, example: "abc" }),
          param({ name: "Accept", in: "header", example: "text/csv" }),
          param({ name: "authorization", in: "header", example: "nope" }),
          param({ name: "session", in: "cookie", example: "abc" }),
          param({ name: "theme", in: "cookie", required: false, example: "dark" }),
        ],
      }),
    );
    expect(request.headers).toEqual({ "X-Version": "2026-01-01", Cookie: "session=abc" });
  });
});

describe("exampleRequest: the body", () => {
  it("is the example as pretty JSON, with the body's content type", () => {
    const request = exampleRequest(doc(), operation({ kind: "POST", body: body({ title: "Dark mode", tags: ["ui"] }) }));
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({ "Content-Type": "application/json" });
    expect(request.body).toBe('{\n  "title": "Dark mode",\n  "tags": [\n    "ui"\n  ]\n}');
  });

  it("is JSON for a JSON content type even when the example is a string", () => {
    const request = exampleRequest(doc(), operation({ kind: "PUT", body: body("on", "application/merge-patch+json") }));
    expect(request.body).toBe('"on"');
    expect(request.headers["Content-Type"]).toBe("application/merge-patch+json");
  });

  it("is the example as text for other content types when it's a string, else JSON", () => {
    expect(exampleRequest(doc(), operation({ kind: "POST", body: body("a,b\n1,2", "text/csv") })).body).toBe("a,b\n1,2");
    expect(exampleRequest(doc(), operation({ kind: "POST", body: body({ a: 1 }, "application/xml") })).body).toBe('{\n  "a": 1\n}');
  });

  it("is a form's fields for a form-encoded body", () => {
    const request = exampleRequest(
      doc(),
      operation({ kind: "POST", body: body({ email: "e2e-a+b@example.com", tags: ["a", "b c"], n: 1 }, "application/x-www-form-urlencoded") }),
    );
    expect(request.body).toBe("email=e2e-a%2Bb%40example.com&tags=a&tags=b+c&n=1");
    expect(request.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("is nothing on GET and HEAD, which can't carry one from a browser", () => {
    expect(exampleRequest(doc(), operation({ kind: "GET", body: body({ a: 1 }) }))).toMatchObject({ body: null, headers: {} });
    expect(exampleRequest(doc(), operation({ kind: "HEAD", body: body({ a: 1 }) }))).toMatchObject({ body: null, headers: {} });
  });

  it("is nothing without a body or an example", () => {
    expect(exampleRequest(doc(), operation()).body).toBeNull();
    const request = exampleRequest(doc(), operation({ kind: "POST", body: body(undefined) }));
    expect(request).toMatchObject({ body: null, headers: {} });
  });
});

describe("exampleRequest: GraphQL", () => {
  it("posts the query and its variables to the server", () => {
    const request = exampleRequest(
      doc({ format: "graphql", servers: [{ url: "https://api.acme.test/graphql", description: "" }], auth: [auth("bearer")] }),
      operation({
        key: "query post",
        kind: "query",
        path: "post",
        auth: [["bearer"]],
        query: { text: "query Post($id: ID!) {\n  post(id: $id) { title }\n}", variables: { id: "1" } },
      }),
    );
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.acme.test/graphql");
    expect(request.headers).toEqual({ Authorization: "Bearer YOUR_API_KEY", "Content-Type": "application/json" });
    expect(JSON.parse(request.body!)).toEqual({
      query: "query Post($id: ID!) {\n  post(id: $id) { title }\n}",
      variables: { id: "1" },
    });
  });
});

describe("exampleRequest: signing", () => {
  const signed = (scheme: ApiAuth, token?: string) =>
    exampleRequest(doc({ auth: [scheme] }), operation({ auth: [[scheme.key]] }), { token });

  it("signs each kind its own way, with a placeholder for the key", () => {
    expect(signed(auth("bearer")).headers).toEqual({ Authorization: "Bearer YOUR_API_KEY" });
    expect(signed(auth("oauth2")).headers).toEqual({ Authorization: "Bearer YOUR_API_KEY" });
    expect(signed(auth("openIdConnect")).headers).toEqual({ Authorization: "Bearer YOUR_API_KEY" });
    expect(signed(auth("basic")).headers).toEqual({ Authorization: "Basic YOUR_API_KEY" });
    expect(signed(auth("header", "X-Api-Key")).headers).toEqual({ "X-Api-Key": "YOUR_API_KEY" });
    expect(signed(auth("cookie", "session")).headers).toEqual({ Cookie: "session=YOUR_API_KEY" });
    const query = signed(auth("query", "api_key"));
    expect(query.headers).toEqual({});
    expect(query.url).toBe("https://api.acme.test/v1/posts?api_key=YOUR_API_KEY");
  });

  it("uses the token it's given", () => {
    expect(signed(auth("bearer"), "tuti_123").headers).toEqual({ Authorization: "Bearer tuti_123" });
    expect(signed(auth("query", "key"), "a b&c").url).toBe("https://api.acme.test/v1/posts?key=a%20b%26c");
  });

  it("signs the first of the operation's ways, with every key it needs together, and not at all when it names none", () => {
    const schemes = [auth("basic"), auth("header", "X-Api-Key"), auth("header", "X-Account"), auth("cookie", "session")];
    const headers = (ways: string[][]) => exampleRequest(doc({ auth: schemes }), operation({ auth: ways })).headers;
    schemes[2]!.key = "account";
    expect(headers([["header", "account", "gone"], ["basic"]])).toEqual({ "X-Api-Key": "YOUR_API_KEY", "X-Account": "YOUR_API_KEY" });
    expect(headers([["basic"], ["header"]])).toEqual({ Authorization: "Basic YOUR_API_KEY" });
    expect(headers([])).toEqual({});
    expect(headers([["gone"], ["basic"]])).toEqual({});
  });

  it("keeps the key when a parameter has its name", () => {
    const request = exampleRequest(
      doc({ auth: [auth("query", "key"), auth("header", "X-Api-Key"), auth("cookie", "session")] }),
      operation({
        auth: [["query", "header", "cookie"]],
        params: [
          param({ name: "key", in: "query" }),
          param({ name: "q", in: "query", example: "x" }),
          param({ name: "x-api-key", in: "header" }),
          param({ name: "theme", in: "cookie", example: "dark" }),
          param({ name: "session", in: "cookie" }),
        ],
      }),
    );
    expect(request.url).toBe("https://api.acme.test/v1/posts?q=x&key=YOUR_API_KEY");
    expect(request.headers).toEqual({ "X-Api-Key": "YOUR_API_KEY", Cookie: "theme=dark; session=YOUR_API_KEY" });
  });
});

/** The arguments a shell hands curl for the command, by running it with a `curl` that prints them. */
function curlArguments(command: string): string[] {
  const out = execFileSync("sh", ["-c", `curl() { for a in "$@"; do printf '%s\\0' "$a"; done; }\n${command}`], {
    env: { PATH: process.env.PATH ?? "", HOME: "/nowhere", x: "leaked" },
  });
  return out.toString("utf8").split("\0").slice(0, -1);
}

/** What the JavaScript example hands `fetch`, by running it. */
async function fetchArguments(code: string): Promise<{ url: string; init: { method: string; headers?: Record<string, string>; body?: string } }> {
  const calls: unknown[][] = [];
  const context = {
    fetch: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ text: () => Promise.resolve("") });
    },
  };
  await runInNewContext(`(async () => {\n${code}\n})()`, context);
  expect(calls).toHaveLength(1);
  const [url, init] = calls[0] as [string, { method: string; headers?: Record<string, string>; body?: string }];
  return { url, init };
}

/** A Python string literal's value: the examples write them as JSON strings, which Python reads the same way. */
function pythonArgument(code: string, name: string): string {
  const line = code.split("\n").find((l) => l.startsWith(`    ${name}=`));
  expect(line).toBeDefined();
  const literal = line!.slice(`    ${name}=`.length).replace(/(\.encode\("utf-8"\))?,$/, "");
  return JSON.parse(literal) as string;
}

describe("requestExamples", () => {
  const acme = doc({ auth: [auth("bearer")] });
  const create = operation({ key: "POST /posts", kind: "POST", auth: [["bearer"]], body: body({ title: "Dark mode" }) });

  it("writes the request as cURL, JavaScript and Python", () => {
    const { curl, javascript, python } = requestExamples(acme, create);
    expect(curl).toBe(
      [
        "curl 'https://api.acme.test/v1/posts' \\",
        "  --request POST \\",
        "  --header 'Authorization: Bearer YOUR_API_KEY' \\", // gitleaks:allow (the placeholder a reader replaces)
        "  --header 'Content-Type: application/json' \\",
        "  --data-raw '{",
        '  "title": "Dark mode"',
        "}'",
      ].join("\n"),
    );
    expect(javascript).toBe(
      [
        'const response = await fetch("https://api.acme.test/v1/posts", {',
        '  method: "POST",',
        "  headers: {",
        '    "Authorization": "Bearer YOUR_API_KEY",',
        '    "Content-Type": "application/json"',
        "  },",
        "  body: JSON.stringify({",
        '    "title": "Dark mode"',
        "  }),",
        "});",
        "const text = await response.text();",
      ].join("\n"),
    );
    expect(python).toBe(
      [
        "import requests",
        "",
        "response = requests.post(",
        '    "https://api.acme.test/v1/posts",',
        "    headers={",
        '        "Authorization": "Bearer YOUR_API_KEY",',
        '        "Content-Type": "application/json"',
        "    },",
        '    data="{\\n  \\"title\\": \\"Dark mode\\"\\n}",',
        ")",
        "print(response.text)",
      ].join("\n"),
    );
  });

  it("keeps a plain GET plain", () => {
    const { curl, javascript, python } = requestExamples(doc(), operation());
    expect(curl).toBe("curl 'https://api.acme.test/v1/posts'");
    expect(javascript).toBe(
      'const response = await fetch("https://api.acme.test/v1/posts", {\n  method: "GET",\n});\nconst text = await response.text();',
    );
    expect(python).toBe('import requests\n\nresponse = requests.get(\n    "https://api.acme.test/v1/posts",\n)\nprint(response.text)');
  });

  it("asks curl and requests for the methods they have no shorthand for", () => {
    expect(requestExamples(doc(), operation({ kind: "HEAD" })).curl).toBe("curl 'https://api.acme.test/v1/posts' \\\n  --head");
    expect(requestExamples(doc(), operation({ kind: "DELETE" })).curl).toContain("--request DELETE");
    expect(requestExamples(doc(), operation({ kind: "TRACE" })).python).toContain(
      'requests.request(\n    "TRACE",\n    "https://api.acme.test/v1/posts",\n)',
    );
  });

  it("stops curl reading a parameter left in the address as a list", () => {
    const { curl } = requestExamples(doc(), operation({ path: "/posts/{number}" }));
    expect(curlArguments(curl)).toEqual(["https://api.acme.test/v1/posts/{number}", "--globoff"]);
  });

  it.each([
    ["a JSON body", body({ text: NASTY, [NASTY]: [NASTY] })],
    ["a text body", body(NASTY, "text/plain")],
    ["a text body that starts like a file's name", body("@/etc/passwd", "text/plain")],
    ["a JSON body with a __proto__ key", body(JSON.parse('{"__proto__": {"a": 1}, "b": "\'"}'))],
  ])("sends %s as it is, whatever is in it", async (_name, requestBody) => {
    const op = operation({
      kind: "POST",
      path: "/posts/{id}",
      auth: [["bearer"]],
      body: requestBody,
      params: [
        param({ name: "id", in: "path", example: NASTY }),
        param({ name: "q", in: "query", example: NASTY }),
        param({ name: "X-Note", in: "header", example: "it's \"quoted\" \\ $HOME `id` ${x} $(id)" }),
      ],
    });
    const request = exampleRequest(acme, op, { token: "to'ken\"$HOME`id`\\" });
    const { curl, javascript, python } = requestExamples(acme, op, { token: "to'ken\"$HOME`id`\\" });
    const headers = Object.entries(request.headers);
    expect(request.body).not.toBeNull();

    expect(curlArguments(curl)).toEqual([
      request.url,
      "--request",
      "POST",
      ...headers.flatMap(([name, value]) => ["--header", `${name}: ${value}`]),
      "--data-raw",
      request.body,
    ]);

    const { url, init } = await fetchArguments(javascript);
    expect(url).toBe(request.url);
    expect(init.method).toBe("POST");
    expect(Object.entries(init.headers!)).toEqual(headers);
    if (request.headers["Content-Type"] === "application/json") {
      expect(JSON.parse(init.body!)).toEqual(JSON.parse(request.body!));
      expect(Object.keys(JSON.parse(init.body!) as object)).toEqual(Object.keys(JSON.parse(request.body!) as object));
    } else expect(init.body).toBe(request.body);

    expect(pythonArgument(python, "data")).toBe(request.body);
    expect(python).toContain(`\n    ${JSON.stringify(request.url)},\n`);
  });

  it("sends Python's body as UTF-8 when it has more than ASCII in it", () => {
    expect(requestExamples(doc(), operation({ kind: "POST", body: body({ title: "日本" }) })).python).toContain(
      '    data="{\\n  \\"title\\": \\"日本\\"\\n}".encode("utf-8"),',
    );
  });

  it("writes GraphQL as a POST of its query and variables", async () => {
    const query = { text: 'query Post($id: ID!) {\n  post(id: $id, note: "it\'s") { title }\n}', variables: { id: "1" } };
    const graphql = doc({ format: "graphql", servers: [{ url: "https://api.acme.test/graphql", description: "" }] });
    const { curl, javascript } = requestExamples(graphql, operation({ kind: "query", path: "post", query }));
    const args = curlArguments(curl);
    expect(args.slice(0, 5)).toEqual(["https://api.acme.test/graphql", "--request", "POST", "--header", "Content-Type: application/json"]);
    expect(JSON.parse(args[6]!)).toEqual({ query: query.text, variables: query.variables });
    const { init } = await fetchArguments(javascript);
    expect(JSON.parse(init.body!)).toEqual({ query: query.text, variables: query.variables });
  });
});
