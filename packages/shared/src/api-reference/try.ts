import { absolute, hasHost, trimSlashes } from "./examples";
import type { ApiAuth, ApiDoc, ApiOperation, ApiParam, ApiServer } from "./types";

/**
 * Try it (docs/plan.md, API reference in Docs, A12): the request a reader fills in on an operation's page, made into
 * the request that's sent. The console makes it to send from the browser, and Tuti's server makes it again from the
 * same input before passing it on (it never takes an address from the browser), so both go by these rules.
 */

/** A server Try it can send to: the spec's, with a host (and the reference's base under one without), with its variables. */
export type TryServer = { url: string; description: string; variables?: ApiServer["variables"] };

/** What the reader filled in. */
export type TryInput = {
  /** One of `tryServers`' urls. */
  server: string;
  /** Its variables' values, by name; one left out takes its default. */
  variables: Record<string, string>;
  /** Path parameters by name. */
  path: Record<string, string>;
  /** Query parameters, headers and cookies as name-value pairs: the key's among them, under its scheme's name. */
  query: [string, string][];
  headers: [string, string][];
  cookies: [string, string][];
  body: string | null;
};

export type TryRequest = { method: string; url: URL; headers: [string, string][]; body: string | null };

/** The most a body may be. */
export const TRY_MAX_BODY_BYTES = 1_000_000;

/**
 * Headers never sent, whatever the spec calls a parameter: the connection's own, the ones that say where a request
 * came from, and Cookie (made from the cookies alone).
 */
const NEVER = /^(host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|expect|content-length|cookie|forwarded|via|x-forwarded-.*|x-real-ip)$/i;

/**
 * Where the operation's requests can go: its servers (else the doc's) that name a host, or, without one, on the
 * reference's base address; the base alone when the spec names none. Empty: nowhere known, so no Try it.
 */
export function tryServers(doc: ApiDoc, operation: ApiOperation, base: string | null | undefined): TryServer[] {
  // A base may have a query ("https://gateway.example/proxy?tenant=acme"): a server's path goes before it.
  const [, basePath = "", baseQuery = ""] = /^([^?#]*)\??([^#]*)/.exec(base ?? "") ?? [];
  const onBase = (path: string) => absolute(path, trimSlashes(basePath, "end")) + (baseQuery ? `?${baseQuery}` : "");
  const specs = operation.servers?.length ? operation.servers : doc.servers;
  if (specs.length === 0) {
    return basePath ? [{ url: base!, description: "" }] : [];
  }
  return specs.flatMap((server) => {
    const filled = fillServer(server, {});
    if (hasHost("url" in filled ? filled.url : server.url)) {
      return [{ url: server.url, description: server.description, ...(server.variables && { variables: server.variables }) }];
    }
    return basePath ? [{ url: onBase(server.url), description: server.description, ...(server.variables && { variables: server.variables }) }] : [];
  });
}

/**
 * A server's address with its variables filled: the reader's values, else the spec's defaults. What the spec gives
 * (a default, or one of a variable's allowed values) goes in as it is, so `{baseUrl}` with the default
 * "https://api.acme.com" is that address; anything else the reader typed is encoded, so it can't end the host or start
 * a path, query or fragment of its own. One filling for the page's check and the request, so what's offered is what's sent.
 */
function fillServer(server: Pick<ApiServer, "url" | "variables">, values: Record<string, string>): { url: string } | { missing: string } {
  let missing: string | null = null;
  const url = server.url.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const variable = server.variables?.[name];
    const value = values[name] ?? variable?.default;
    if (value === undefined || value === "") {
      missing ??= name;
      return "";
    }
    return value === variable?.default || variable?.enum?.includes(value) ? value : encodeURIComponent(value);
  });
  return missing === null ? { url } : { missing };
}

/** Whether an operation's page has Try it: an OpenAPI operation with somewhere to send it. */
export const tryable = (doc: ApiDoc, operation: ApiOperation, base: string | null | undefined) =>
  doc.format === "openapi" && !operation.query && tryServers(doc, operation, base).length > 0;

/**
 * The ways of signing the console asks a key for: the first of the operation's whose schemes are all known (as the
 * page names them), and whether it may go unsigned.
 */
export function tryAuth(doc: ApiDoc, operation: ApiOperation): { schemes: ApiAuth[]; optional: boolean } {
  const ways = operation.auth
    .filter((keys) => keys.length > 0)
    .map((keys) => keys.map((key) => doc.auth.find((scheme) => scheme.key === key)))
    .filter((way): way is ApiAuth[] => way.every((scheme) => scheme !== undefined));
  return { schemes: ways[0] ?? [], optional: operation.auth.length === 0 || operation.auth.some((keys) => keys.length === 0) };
}

/** The header a scheme's key goes in, when it goes in one. */
const authHeader = (auth: ApiAuth) => (auth.kind === "header" ? auth.name : auth.kind === "query" || auth.kind === "cookie" ? null : "Authorization");

const lower = (names: (string | null)[]) => new Set(names.filter((name): name is string => !!name).map((name) => name.toLowerCase()));

/** A header's or cookie's value can't start another one. */
const BREAKS = /[\r\n\0]/;

/** The request `input` makes of the operation, or why it can't be sent. Where it goes is checked by whoever sends it. */
export function tryRequest(doc: ApiDoc, operation: ApiOperation, base: string | null | undefined, input: TryInput): TryRequest | { error: string } {
  if (!tryable(doc, operation, base)) {
    return { error: "This operation can't be tried here" };
  }
  const server = tryServers(doc, operation, base).find((s) => s.url === input.server);
  if (!server) {
    return { error: "Pick one of the API's servers" };
  }
  const address = fillServer(server, input.variables);
  if ("missing" in address) {
    return { error: `Fill in the server's ${address.missing}` };
  }
  const filled = address.url;
  let missing: string | null = null;
  let url: URL;
  try {
    url = new URL(filled.startsWith("//") ? `https:${filled}` : filled);
  } catch {
    return { error: "The server's address isn't valid" };
  }
  if (url.username || url.password) {
    return { error: "The server's address can't have a user or password in it" };
  }
  url.hash = "";
  const path = operation.path.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const value = input.path[name];
    // "." and ".." would be read as moving up the path.
    if (value === undefined || value === "" || value === "." || value === "..") {
      missing ??= name;
      return "";
    }
    return encodeURIComponent(value);
  });
  if (missing !== null) {
    return { error: `Fill in ${missing}` };
  }
  url.pathname = `${trimSlashes(url.pathname, "end")}/${trimSlashes(path, "start")}`;

  const { schemes } = tryAuth(doc, operation);
  const declared = (place: "query" | "header" | "cookie") => operation.params.filter((param) => param.in === place).map((param) => param.name);
  // An object query parameter goes as its fields (`queryPairs`): theirs are its names, or any name when it lists none.
  const objects = operation.params.filter((param) => param.in === "query" && isObject(param));
  const anyName = objects.some((param) => !param.schema.properties?.length);
  const queries = lower([
    ...declared("query"),
    ...objects.flatMap((param) => param.schema.properties?.map((field) => field.name) ?? []),
    ...schemes.filter((s) => s.kind === "query").map((s) => s.name),
  ]);
  const headers = lower([...declared("header"), ...schemes.map(authHeader), operation.body && "Content-Type", "Accept"]);
  const cookies = new Set([...declared("cookie"), ...schemes.filter((s) => s.kind === "cookie").map((s) => s.name)]);
  for (const [name, value] of input.query) {
    if (!anyName && !queries.has(name.toLowerCase())) {
      return { error: `${name} isn't one of this operation's query parameters` };
    }
    url.searchParams.append(name, value);
  }
  const sent: [string, string][] = [];
  for (const [name, value] of input.headers) {
    if (!headers.has(name.toLowerCase()) || NEVER.test(name)) {
      return { error: `${name} isn't one of this operation's headers` };
    }
    if (BREAKS.test(value)) {
      return { error: `${name} can't have a line break in it` };
    }
    sent.push([name, value]);
  }
  for (const [name, value] of input.cookies) {
    if (!cookies.has(name)) {
      return { error: `${name} isn't one of this operation's cookies` };
    }
    if (BREAKS.test(value) || value.includes(";")) {
      return { error: `${name} can't have a line break or a semicolon in it` };
    }
  }
  if (input.cookies.length > 0) {
    sent.push(["Cookie", input.cookies.map(([name, value]) => `${name}=${value}`).join("; ")]);
  }
  const method = operation.kind;
  // fetch sends no body with GET or HEAD.
  const body = method === "GET" || method === "HEAD" ? null : input.body;
  if (body !== null && new TextEncoder().encode(body).length > TRY_MAX_BODY_BYTES) {
    return { error: "The body is over 1 MB" };
  }
  return { method, url, headers: sent, body };
}

/** What the console's fields hold: parameters by `<in>:<name>`; keys by their scheme's key (Basic's as `<key>:user` and `<key>:password`). */
export type TryForm = { server: string; variables: Record<string, string>; params: Record<string, string>; keys: Record<string, string>; body: string };

/**
 * The parameters the console asks for: path, query and header ones, without the headers OpenAPI has ignored as
 * parameters (Authorization, Accept, Content-Type: the key and the body set them), those never sent, and any named
 * like where the key goes (specs often list the key as a parameter too): the key takes its place, as in the examples.
 */
export function tryParams(doc: ApiDoc, operation: ApiOperation): ApiParam[] {
  const schemes = tryAuth(doc, operation).schemes;
  const keyIn = (place: "header" | "query") => lower(schemes.filter((s) => s.kind === place).map((s) => s.name));
  const [headers, queries] = [keyIn("header"), keyIn("query")];
  return operation.params.filter((param) =>
    param.in === "path"
      ? true
      : param.in === "query"
        ? !queries.has(param.name.toLowerCase())
        : param.in === "header" && !/^(authorization|accept|content-type)$/i.test(param.name) && !NEVER.test(param.name) && !headers.has(param.name.toLowerCase()),
  );
}

/** Whether a query parameter is an object, sent as its fields. */
const isObject = (param: ApiParam) => param.schema.type === "object" || !!param.schema.properties;

/**
 * A query parameter's field as its pairs, as OpenAPI sends one unless told otherwise (and as the examples show it): an
 * array's items each under its name ("1,2" is `ids=1&ids=2`), an object's fields each under the field's name.
 */
function queryPairs(param: ApiParam, text: string): [string, string][] {
  if (param.schema.type.startsWith("array")) {
    return text.split(",").map((item): [string, string] => [param.name, item.trim()]).filter(([, item]) => item !== "");
  }
  if (isObject(param)) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return Object.entries(value).map(([field, item]): [string, string] => [field, typeof item === "string" ? item : JSON.stringify(item)]);
      }
    } catch {
      // Not JSON: as typed.
    }
  }
  return [[param.name, text]];
}

/** Base64 of text as UTF-8, as Basic authentication sends a username and password. */
const base64 = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));

/** What the console's fields make for `tryRequest`: the parameters filled in, the key where its scheme puts it, the body with its type. */
export function tryInput(doc: ApiDoc, operation: ApiOperation, form: TryForm): TryInput {
  const input: TryInput = { server: form.server, variables: form.variables, path: {}, query: [], headers: [], cookies: [], body: operation.body ? form.body : null };
  for (const param of tryParams(doc, operation)) {
    const value = form.params[`${param.in}:${param.name}`] ?? "";
    if (param.in === "path") input.path[param.name] = value;
    else if (value === "") continue;
    else if (param.in === "query") input.query.push(...queryPairs(param, value));
    else input.headers.push([param.name, value]);
  }
  for (const scheme of tryAuth(doc, operation).schemes) {
    const value = form.keys[scheme.key] ?? "";
    if (scheme.kind === "basic") {
      const [user = "", password = ""] = [form.keys[`${scheme.key}:user`], form.keys[`${scheme.key}:password`]];
      if (user || password) input.headers.push(["Authorization", `Basic ${base64(`${user}:${password}`)}`]);
    } else if (value === "") continue;
    else if (scheme.kind === "header") input.headers.push([scheme.name, value]);
    else if (scheme.kind === "query") input.query.push([scheme.name, value]);
    else if (scheme.kind === "cookie") input.cookies.push([scheme.name, value]);
    else input.headers.push(["Authorization", `Bearer ${value}`]);
  }
  if (operation.body && input.body) input.headers.push(["Content-Type", operation.body.contentType]);
  return input;
}

/** The request's address to show, a key in its query as "****": the key's own field hides it. */
export function shownUrl(doc: ApiDoc, operation: ApiOperation, request: TryRequest): string {
  const url = new URL(request.url);
  for (const scheme of tryAuth(doc, operation).schemes) {
    if (scheme.kind === "query" && url.searchParams.has(scheme.name)) url.searchParams.set(scheme.name, "****");
  }
  return url.href;
}

/**
 * The start of an answer's body, up to `max` bytes, read as it arrives and the rest cancelled: a huge or endless one
 * can't fill the tab. Its text is those bytes (a character cut at the end is dropped); `size` is how many were read.
 */
export async function readUpTo(stream: ReadableStream<Uint8Array> | null, max: number): Promise<{ text: string; size: number; cut: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  if (stream) {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > max) {
        cut = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const bytes = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at);
    bytes.set(part, at);
    at += part.length;
  }
  // Not fatal: a character the cut split in two is left off rather than refused.
  const text = new TextDecoder().decode(bytes, { stream: cut });
  return { text, size: Math.min(size, max), cut };
}
