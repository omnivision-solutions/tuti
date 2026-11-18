import { prisma } from "@tuti/db";
import type { TryInput } from "@tuti/shared/api-reference";
import { type ApiFake, startApiFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST } from "@/app/portal/[project]/(site)/docs/[slug]/[operation]/try/route";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { TRIES_PER_CLIENT_PER_MINUTE, TRIES_PER_PROJECT_PER_HOUR, TRY_MAX_RESPONSE_BYTES, type TryAnswer } from "./api-try";
import { clientHash } from "./email-link-limits";
import { createTab } from "./operations/docs";
import { createApiReference, updateApiReference } from "./operations/api-references";
import { call } from "./operations/run";

/**
 * Try it through Tuti (server/api-try.ts): each of the proxy's limits. Upstream is a local fake (`startApiFake`); names
 * resolve from fixed answers here, so nothing reaches the network: a request that passes every check up to connecting
 * to a name either reaches the fake (journeys' localhost, TRY_IT_ALLOW_LOCALHOST) or is refused at a private address.
 */

/** The answers connections get (publicOnlyLookup's), and what a check before connecting would have seen. */
const CONNECT: Record<string, string> = {
  "loop.acme.com": "127.0.0.1",
  "internal.acme.com": "10.0.0.5",
  "metadata.acme.com": "169.254.169.254",
  "rebind.acme.com": "10.0.0.7",
  "acme.github.io": "10.0.0.8",
};
vi.mock("node:dns", async (importOriginal) => {
  const dns = await importOriginal<typeof import("node:dns")>();
  return {
    ...dns,
    lookup: (host: string, _options: unknown, callback: (error: Error | null, addresses?: unknown) => void) =>
      CONNECT[host]
        ? callback(null, [{ address: CONNECT[host], family: 4 }])
        : callback(Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" })),
  };
});
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  // DNS rebinding: a lookup of its own (a check) is told a public address.
  lookup: async (host: string) => (host === "rebind.acme.com" ? [{ address: "93.184.215.14", family: 4 }] : []),
}));

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let fake: ApiFake;

const spec = (local: string) => `
openapi: 3.1.0
info: { title: Acme API, version: "1" }
servers:
  - { url: "https://{tenant}.acme.com/v1", variables: { tenant: { default: api } } }
  - { url: "https://{host}/v1", variables: { host: { default: api.acme.com } } }
  - { url: "https://api.other.com" }
  - { url: "http://api.acme.com" }
  - { url: "https://169.254.169.254" }
  - { url: "https://evil.github.io" }
  - { url: "https://acme.github.io/api" }
  - { url: "${local}/v1" }
components:
  securitySchemes:
    key: { type: http, scheme: bearer }
security: [{ key: [] }]
paths:
  /posts/{number}:
    post:
      tags: [Posts]
      summary: Update a post
      parameters:
        - { name: number, in: path, required: true, schema: { type: integer } }
        - { name: board, in: query, schema: { type: string } }
        - { name: X-Team, in: header, schema: { type: string } }
        - { name: Host, in: header, schema: { type: string } }
      requestBody: { content: { application/json: { schema: { type: object } } } }
      responses: { "201": { description: Updated } }
  /redirect:
    get: { tags: [Posts], summary: Moved, responses: { "302": { description: Elsewhere } } }
  /large:
    get:
      tags: [Posts]
      summary: Large
      parameters: [{ name: size, in: query, schema: { type: integer } }]
      responses: { "200": { description: Text } }
  /internal/purge:
    post: { tags: [Internal], summary: Purge, responses: { "204": { description: Gone } } }
`;

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

beforeAll(async () => {
  fake = await startApiFake({ cors: false });
});
afterAll(() => fake.close());

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  await call(createTab, as(), { name: "API" });
  await call(createApiReference, as(), { name: "Reference", spec: spec(fake.origin), tab: "api" });
  await call(updateApiReference, as(), { slug: "reference", hideGroups: ["Internal"] });
  // One project at a time holds a verified hostname: the last test's goes.
  await prisma.customDomain.deleteMany({});
  await prisma.customDomain.create({ data: { projectId: project.id, hostname: "help.acme.com", verificationToken: "t", verifiedAt: new Date() } });
  fake.requests.length = 0;
  actAs(null);
});
afterEach(() => vi.unstubAllEnvs());

const input = (server: string, rest: Partial<TryInput> = {}): TryInput => ({
  server,
  variables: {},
  path: { number: "7" },
  query: [],
  headers: [],
  cookies: [],
  body: null,
  ...rest,
});

/** Posts `body` to the operation's /try, as the console does (JSON), with `headers` too. */
async function send(body: unknown, { operation = "update-a-post", headers = {} as Record<string, string>, raw = false } = {}) {
  const request = new Request(`http://${project.slug}.localhost:3100/docs/reference/${operation}/try`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  const response = await POST(request, { params: Promise.resolve({ project: project.slug, slug: "reference", operation }) });
  return { status: response.status, json: (await response.json()) as TryAnswer & { error?: string } };
}

const local = () => `${fake.origin}/v1`;

describe("where it sends", () => {
  test("a host off the project's sites is refused", async () => {
    expect(await send(input("https://api.other.com"))).toMatchObject({ status: 403, json: { error: expect.stringContaining("api.other.com isn't one") } });
  });

  test("a host on the same registrable domain as a verified one passes the check (here, to a private address)", async () => {
    // api.acme.com for help.acme.com: it gets as far as connecting, where the name's address (private here) stops it.
    expect(await send(input("https://{tenant}.acme.com/v1", { variables: { tenant: "loop" } }))).toMatchObject({ status: 403, json: { error: "Tuti sends requests only to public addresses" } });
    // Without a verified domain, nothing is the project's.
    await prisma.customDomain.updateMany({ where: { projectId: project.id }, data: { verifiedAt: null } });
    expect(await send(input("https://{tenant}.acme.com/v1", { variables: { tenant: "loop" } }))).toMatchObject({ status: 403, json: { error: expect.stringContaining("isn't one") } });
    // A verified email domain counts, as does a verified site the portal is under.
    await prisma.emailDomain.create({ data: { projectId: project.id, domain: "acme.com", address: "help@acme.com", verifiedAt: new Date() } });
    expect((await send(input("https://{tenant}.acme.com/v1", { variables: { tenant: "loop" } }))).json.error).toBe("Tuti sends requests only to public addresses");
    await prisma.emailDomain.deleteMany({ where: { projectId: project.id } });
    await prisma.siteMount.create({ data: { projectId: project.id, origin: "https://www.acme.com", path: "/portal", verificationToken: "t", verifiedAt: new Date() } });
    expect((await send(input("https://{tenant}.acme.com/v1", { variables: { tenant: "loop" } }))).json.error).toBe("Tuti sends requests only to public addresses");
  });

  test("another name under a shared suffix (github.io) isn't the project's", async () => {
    await prisma.customDomain.updateMany({ where: { projectId: project.id }, data: { hostname: "acme.github.io" } });
    expect(await send(input("https://evil.github.io"))).toMatchObject({ status: 403, json: { error: expect.stringContaining("evil.github.io isn't one") } });
    // Its own name is.
    expect((await send(input("https://acme.github.io/api"))).json.error).toBe("Tuti sends requests only to public addresses");
  });

  test("a server variable filled with another host is checked as filled in", async () => {
    expect(await send(input("https://{host}/v1", { variables: { host: "evil.com" } }))).toMatchObject({ status: 403, json: { error: expect.stringContaining("evil.com isn't one") } });
    // Encoded, a variable can't end the host and start a path or a user of its own.
    for (const host of ["evil.com/x?", "api.acme.com@evil.com", "evil.com#.acme.com"]) {
      expect((await send(input("https://{host}/v1", { variables: { host } }))).status).toBe(400);
    }
    expect((await send(input("https://{tenant}.acme.com/v1", { variables: { tenant: "evil.com/" } }))).status).toBe(400);
    // A server that isn't one of the spec's is refused, whatever its host.
    expect(await send(input("https://api.acme.com/v1"))).toMatchObject({ status: 400, json: { error: "Pick one of the API's servers" } });
  });

  test("only over https, and never to an IP address", async () => {
    expect(await send(input("http://api.acme.com"))).toMatchObject({ status: 403, json: { error: "Tuti sends requests only over https" } });
    expect(await send(input("https://169.254.169.254"))).toMatchObject({ status: 403, json: { error: expect.stringContaining("169.254.169.254 isn't one") } });
  });

  test.each([
    ["loop", "127.0.0.1"],
    ["internal", "10.x"],
    ["metadata", "169.254.169.254"],
  ])("a name that resolves to a private address (%s: %s) is refused", async (tenant) => {
    expect(await send(input("https://{tenant}.acme.com/v1", { variables: { tenant } }))).toMatchObject({ status: 403, json: { error: "Tuti sends requests only to public addresses" } });
  });

  test("DNS rebinding: a name public to a check and private on connecting is refused, as the address connected to is the one checked", async () => {
    expect(await send(input("https://{tenant}.acme.com/v1", { variables: { tenant: "rebind" } }))).toMatchObject({ status: 403, json: { error: "Tuti sends requests only to public addresses" } });
  });

  test("journeys' localhost counts only with TRY_IT_ALLOW_LOCALHOST, and only while the app is on localhost", async () => {
    expect(await send(input(local()))).toMatchObject({ status: 403, json: { error: "Tuti sends requests only over https" } });
    vi.stubEnv("TRY_IT_ALLOW_LOCALHOST", "true");
    vi.stubEnv("APP_URL", "https://tuti.example");
    expect((await send(input(local()))).status).toBe(403);
    vi.stubEnv("APP_URL", "http://tuti.localhost:3100");
    expect((await send(input(local()))).status).toBe(200);
  });
});

describe("what it sends and answers", () => {
  beforeEach(() => vi.stubEnv("TRY_IT_ALLOW_LOCALHOST", "true"));

  test("the operation's request as the console filled it in, and none of the reader's own cookies or headers", async () => {
    const { status, json } = await send(
      input(local(), {
        path: { number: "7/../../admin" },
        query: [["board", "ideas & more"]],
        headers: [["Authorization", "Bearer sk_test"], ["X-Team", "core"], ["Content-Type", "application/json"]],
        body: '{"title":"Dark mode"}',
      }),
      { headers: { cookie: "tuti.session_token=secret", authorization: "Bearer tuti_session", "x-forwarded-for": "10.0.0.1" } },
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 201, cut: false, body: expect.stringContaining('"method":"POST"') });
    expect(json.headers).toContainEqual(["x-request-id", "fake-1"]);
    expect(json.size).toBe(json.body.length);
    expect(json.ms).toBeGreaterThanOrEqual(0);
    const [sent] = fake.requests;
    // A path parameter is encoded: it can't climb the path.
    expect(sent).toMatchObject({ method: "POST", path: "/v1/posts/7%2F..%2F..%2Fadmin", query: "?board=ideas+%26+more", body: '{"title":"Dark mode"}' });
    expect(sent!.headers).toMatchObject({ authorization: "Bearer sk_test", "x-team": "core", "content-type": "application/json", "user-agent": "Tuti-Try-It/1" });
    expect(sent!.headers.cookie).toBeUndefined();
    expect(sent!.headers["x-forwarded-for"]).toBeUndefined();
    // "." and ".." are refused outright.
    expect((await send(input(local(), { path: { number: ".." } }))).status).toBe(400);
  });

  test("only the operation's parameters, its content type and the key's header go out; never a connection's headers", async () => {
    for (const headers of [[["Cookie", "a=b"]], [["X-Other", "1"]], [["Host", "evil.com"]], [["X-Team", "a\r\nX-Evil: 1"]]] as [string, string][][]) {
      expect((await send(input(local(), { headers }))).status).toBe(400);
    }
    expect((await send(input(local(), { query: [["admin", "1"]] }))).status).toBe(400);
    expect((await send(input(local(), { cookies: [["session", "x"]] }))).status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  test("a redirect is returned as it is, not followed", async () => {
    const { json } = await send(input(local(), { path: {} }), { operation: "moved" });
    expect(json.status).toBe(302);
    expect(json.headers).toContainEqual(["location", "https://elsewhere.example/"]);
    expect(fake.requests).toHaveLength(1);
  });

  test("a body over 1 MB isn't sent; an answer over 2 MB is cut, and says so", async () => {
    expect(await send(input(local(), { body: "x".repeat(1_000_001) }))).toMatchObject({ status: 413, json: { error: "The body is over 1 MB" } });
    // Nor is a request to us too large to be one this console makes.
    expect((await send(JSON.stringify(input(local(), { body: "x".repeat(3_000_000) })), { raw: true })).status).toBe(413);
    expect(fake.requests).toHaveLength(0);
    const { json } = await send(input(local(), { path: {}, query: [["size", String(TRY_MAX_RESPONSE_BYTES + 500_000)]] }), { operation: "large" });
    expect(json).toMatchObject({ status: 200, cut: true, size: TRY_MAX_RESPONSE_BYTES });
    expect(json.body).toHaveLength(TRY_MAX_RESPONSE_BYTES);
    const whole = await send(input(local(), { path: {}, query: [["size", "10"]] }), { operation: "large" });
    expect(whole.json).toMatchObject({ cut: false, size: 10, body: "x".repeat(10) });
  });

  test("rate limited per reader and per project", async () => {
    vi.stubEnv("TRUSTED_IP_HEADER", "x-test-ip");
    const reader = { "x-test-ip": "203.0.113.9" };
    const client = await clientHash(new Headers(reader));
    await prisma.apiTry.createMany({ data: Array.from({ length: TRIES_PER_CLIENT_PER_MINUTE }, () => ({ projectId: project.id, clientHash: client })) });
    expect(await send(input(local()), { headers: reader })).toMatchObject({ status: 429, json: { error: "Too many requests through Tuti. Try again in a minute." } });
    // Someone else still can, until the project's hour is used up.
    expect((await send(input(local()), { headers: { "x-test-ip": "203.0.113.10" } })).status).toBe(200);
    await prisma.apiTry.createMany({ data: Array.from({ length: TRIES_PER_PROJECT_PER_HOUR }, () => ({ projectId: project.id, clientHash: null })) });
    expect((await send(input(local()), { headers: { "x-test-ip": "203.0.113.11" } })).status).toBe(429);
    expect(fake.requests).toHaveLength(1);
    // Nothing of a request is kept: who and when, for the limits.
    expect(Object.keys((await prisma.apiTry.findFirstOrThrow()) as object).sort()).toEqual(["clientHash", "createdAt", "id", "projectId"]);
  });
});

describe("which operations", () => {
  beforeEach(() => vi.stubEnv("TRY_IT_ALLOW_LOCALHOST", "true"));

  test("one off the help center, or in a tab the reader can't read, is a 404", async () => {
    expect((await send(input(local(), { path: {} }), { operation: "purge" })).status).toBe(404);
    expect((await send(input(local()), { operation: "no-such-operation" })).status).toBe(404);
    await prisma.docsTab.update({ where: { projectId_slug: { projectId: project.id, slug: "api" } }, data: { access: "SIGNED_IN", noAccess: "LOCK" } });
    expect((await send(input(local()))).status).toBe(404);
    // Its readers can.
    actAs(owner);
    expect((await send(input(local()))).status).toBe(200);
    // An unpublished reference has no operations for anyone.
    await call(updateApiReference, as(), { slug: "reference", published: false });
    expect((await send(input(local()))).status).toBe(404);
    expect(fake.requests).toHaveLength(1);
  });

  test("only JSON: a form posted from another site can't make one", async () => {
    const response = await POST(
      new Request(`http://${project.slug}.localhost:3100/docs/reference/update-a-post/try`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(input(local())) }),
      { params: Promise.resolve({ project: project.slug, slug: "reference", operation: "update-a-post" }) },
    );
    expect(response.status).toBe(415);
    expect(fake.requests).toHaveLength(0);
  });
});
