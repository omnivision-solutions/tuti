import type { ApiDoc, ApiOperation, ApiParam, ApiSchema } from "./types";

export type ExampleRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
};

const PLACEHOLDER_HOST = "https://api.example.com";

/** Without the slashes at one end: a loop, as a pattern for it is slow on a long run of them. */
export function trimSlashes(text: string, at: "start" | "end"): string {
  let from = 0;
  let to = text.length;
  if (at === "start") while (from < to && text[from] === "/") from++;
  else while (to > from && text[to - 1] === "/") to--;
  return text.slice(from, to);
}

/**
 * A spec's server as an address that can be called. One without a host ("/v1", "v1") goes on the
 * placeholder's, as nothing here knows where the spec is served; "//host/v1" only lacks its scheme.
 */
/** Whether a spec's server says which host it's on ("https://…", "//host/v1"), not only a path. */
export const hasHost = (server: string) => server.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(server);

export function absolute(server: string, base: string): string {
  if (server.startsWith("//")) return `https:${server}`;
  if (hasHost(server)) return server;
  // "./v1" and "." are relative to where the spec is: the base's root here.
  const path = trimSlashes(server.startsWith("./") ? server.slice(2) : server === "." ? "" : server, "start");
  return path ? `${base}/${path}` : base;
}

export type ExampleOptions = {
  /** Where requests go, whatever the spec says. */
  server?: string;
  /** Where a spec's server without a host is (the reference's `baseUrl`), and where requests go when the spec names no server; the placeholder's host without it. */
  base?: string;
  token?: string;
};

/** The request an operation's page shows and the console starts from. */
export function exampleRequest(doc: ApiDoc, operation: ApiOperation, options: ExampleOptions = {}): ExampleRequest {
  const spec = operation.servers?.[0] ?? doc.servers[0];
  // A server from the spec may have variables in its address; one asked for is used as it is.
  // A base may have a query of its own ("https://gateway.example/proxy?tenant=acme"): paths go before it, and it's kept.
  const [, basePath = "", baseQuery = ""] = /^([^?#]*)\??([^#]*)/.exec(options.base ?? "") ?? [];
  const base = basePath ? trimSlashes(basePath, "end") : PLACEHOLDER_HOST;
  // The spec's server with its variables filled: only then is it clear whether it names a host ("{scheme}://api.example.com").
  const filled = spec?.url.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => spec.variables?.[name]?.default ?? placeholder);
  const onBase = options.server === undefined && !(filled !== undefined && hasHost(filled));
  const server = options.server ?? (filled !== undefined ? absolute(filled, base) : base);
  const token = options.token ?? "YOUR_API_KEY";
  const headers: Record<string, string> = {};
  let query: [name: string, value: string][] = [];
  let cookies: [name: string, value: string][] = [];
  let method = "POST";
  let url = server;
  let body: string | null = null;

  if (operation.query) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ query: operation.query.text, variables: operation.query.variables }, null, 2);
  } else {
    method = operation.kind;
    const path = operation.path.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
      const param = operation.params.find((p) => p.in === "path" && p.name === name);
      const value = param && paramValue(param);
      return value === undefined ? placeholder : encodeURIComponent(asText(value));
    });
    url = `${trimSlashes(server, "end")}/${trimSlashes(path, "start")}`;
    for (const param of operation.params) {
      if (!param.required) continue;
      // What can't be made up stays as "{name}", like a path's, for the reader to fill.
      const value = paramValue(param);
      const text = value === undefined ? `{${param.name}}` : asText(value);
      // OpenAPI has these three ignored as parameters: the body and the signing set them.
      if (param.in === "header" && !/^(authorization|accept|content-type)$/i.test(param.name)) headers[param.name] = text;
      if (param.in === "cookie") cookies.push([param.name, text]);
      if (param.in !== "query") continue;
      if (value === undefined) query.push([param.name, text]);
      // An array is the parameter once per item, as OpenAPI sends one unless told otherwise.
      // And an object is a parameter per field, under the field's name.
      else if (typeof value === "object" && value !== null && !Array.isArray(value))
        for (const [field, item] of Object.entries(value)) query.push([field, encodeURIComponent(asText(item))]);
      else for (const item of Array.isArray(value) ? value : [value]) query.push([param.name, encodeURIComponent(asText(item))]);
    }
    // Not on GET or HEAD: fetch, and so the console, refuses a body there.
    if (operation.body && operation.body.example !== undefined && method !== "GET" && method !== "HEAD") {
      const { contentType, example } = operation.body;
      headers["Content-Type"] = contentType;
      if (typeof example === "string" && !isJson(contentType)) body = example;
      else if (/x-www-form-urlencoded/i.test(contentType) && typeof example === "object" && example !== null)
        body = new URLSearchParams(Object.entries(example).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item): [string, string] => [name, asText(item)]))).toString();
      // ponytail: multipart with an object example goes as JSON, which no server reads; write its parts when a spec needs it
      else body = JSON.stringify(example, null, 2);
    }
  }

  // Signing is read last and written first: a parameter named like a key never takes its place.
  const signed: Record<string, string> = {};
  for (const key of operation.auth[0] ?? []) {
    const auth = doc.auth.find((a) => a.key === key);
    if (!auth) continue;
    // Basic's token is its credentials as they're sent, base64 of "user:password": whoever has the two encodes them.
    if (auth.kind === "basic") signed.Authorization = `Basic ${token}`;
    else if (auth.kind === "header") signed[auth.name] = token;
    else if (auth.kind === "cookie") {
      cookies = cookies.filter(([name]) => name !== auth.name);
      cookies.push([auth.name, token]);
    }
    else if (auth.kind === "query") {
      query = query.filter(([name]) => name !== auth.name);
      query.push([auth.name, encodeURIComponent(token)]);
    } else signed.Authorization = `Bearer ${token}`;
  }
  const taken = new Set(Object.keys(signed).map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(headers)) if (!taken.has(name.toLowerCase())) signed[name] = value;
  if (cookies.length) signed.Cookie = cookies.map(([name, value]) => `${name}=${value}`).join("; ");
  const search = [...(onBase && baseQuery ? [baseQuery] : []), ...query.map(([name, value]) => `${encodeURIComponent(name)}=${value}`)];
  if (search.length) url += (url.includes("?") ? "&" : "?") + search.join("&");
  return { method, url, headers: signed, body };
}

/** That request as text a reader can paste and run. */
export function requestExamples(
  doc: ApiDoc,
  operation: ApiOperation,
  options?: ExampleOptions,
): { curl: string; javascript: string; python: string } {
  const request = exampleRequest(doc, operation, options);
  return { curl: curl(request), javascript: javascript(request), python: python(request) };
}

function isJson(contentType: string) {
  return /json/i.test(contentType);
}

function paramValue(param: ApiParam): unknown {
  return param.example ?? fromSchema(param.schema);
}

function fromSchema(schema: ApiSchema): unknown {
  if (schema.default !== undefined && schema.default !== null) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "string") return "string";
  return undefined;
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(asText).join(",");
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/** Single-quoted for a POSIX shell: nothing inside is special, and a quote is closed, escaped and reopened. */
function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function curl({ method, url, headers, body }: ExampleRequest) {
  const parts = [`curl ${shellQuote(url)}`];
  // curl reads {…} and […] in an address as lists and ranges; a parameter left as "{name}" is neither.
  if (/[[\]{}]/.test(url)) parts.push("--globoff");
  if (method === "HEAD") parts.push("--head");
  else if (method !== "GET") parts.push(`--request ${method}`);
  for (const [name, value] of Object.entries(headers)) parts.push(`--header ${shellQuote(`${name}: ${value}`)}`);
  // --data-raw: --data would read a body starting with "@" as a file's name.
  if (body !== null) parts.push(`--data-raw ${shellQuote(body)}`);
  return parts.join(" \\\n  ");
}

function indent(text: string, by: string) {
  return text.replace(/\n/g, `\n${by}`);
}

/** The body as it was made from its example, when that's JSON that reads the same as a JavaScript literal. */
function jsonBody({ headers, body }: ExampleRequest) {
  if (body === null || !isJson(headers["Content-Type"] ?? "") || body.includes('"__proto__"')) return null;
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && JSON.stringify(value, null, 2) === body ? body : null;
  } catch {
    return null;
  }
}

function javascript(request: ExampleRequest) {
  const { method, url, headers, body } = request;
  // A JSON string is a JavaScript string literal: quotes, backslashes and newlines are escaped, "$" and "`" mean nothing in one.
  const lines = [`method: ${JSON.stringify(method)},`];
  if (Object.keys(headers).length) lines.push(`headers: ${JSON.stringify(headers, null, 2)},`);
  const json = jsonBody(request);
  if (json !== null) lines.push(`body: JSON.stringify(${json}),`);
  else if (body !== null) lines.push(`body: ${JSON.stringify(body)},`);
  return [
    `const response = await fetch(${JSON.stringify(url)}, {`,
    ...lines.map((line) => `  ${indent(line, "  ")}`),
    "});",
    "const text = await response.text();",
  ].join("\n");
}

function python({ method, url, headers, body }: ExampleRequest) {
  // A JSON string is a Python string literal too, and JSON of strings alone a dict.
  const lines = [`${JSON.stringify(url)},`];
  if (method === "TRACE") lines.unshift(`"TRACE",`);
  if (Object.keys(headers).length) lines.push(`headers=${JSON.stringify(headers, null, 4)},`);
  // requests sends text as Latin-1, so anything beyond ASCII goes as UTF-8 bytes.
  if (body !== null) lines.push(`data=${JSON.stringify(body)}${/[^\x00-\x7f]/.test(body) ? '.encode("utf-8")' : ""},`);
  return [
    "import requests",
    "",
    `response = requests.${method === "TRACE" ? "request" : method.toLowerCase()}(`,
    ...lines.map((line) => `    ${indent(line, "    ")}`),
    ")",
    "print(response.text)",
  ].join("\n");
}
