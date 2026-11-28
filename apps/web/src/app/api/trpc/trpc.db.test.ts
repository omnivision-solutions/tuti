import { prisma } from "@tuti/db";
import { log } from "@tuti/shared";
import { startModelFake } from "@tuti/testkit";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import AiFirstPage from "@/app/app/(workspace)/[project]/settings/(admin)/workflows/ai-first/page";
import { appUrl } from "@/lib/hosts";
import { SLOW_MS } from "@/server/trpc/init";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { request as browser } from "@/test/next-headers";

import { GET, POST } from "./[trpc]/route";

/**
 * /api/trpc (docs/plan.md, "One way in"): queries are GETs and mutations POSTs only; a mutation with a cookie must come
 * from the page's own site, as server actions' did; the mobile app's token counts only with the header it always sends.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(null);
  browser.headers = {};
});

const host = () => appUrl().host;
const aiFirst = () => prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { widgetAiFirst: true, emailAiFirst: true, aiName: true } });

/** A call as a browser (or the app) sends it: a query as a GET, a mutation as a POST, with superjson's `{ json }`. */
async function trpc(procedure: string, input: unknown, { method = "GET", headers = {} }: { method?: "GET" | "POST"; headers?: Record<string, string> } = {}) {
  const url = new URL(`${appUrl().origin}/api/trpc/${procedure}`);
  if (method === "GET") {
    url.searchParams.set("input", JSON.stringify({ json: input }));
  }
  const request = new Request(url, {
    method,
    headers: { host: host(), ...(method === "POST" && { "content-type": "application/json" }), ...headers },
    ...(method === "POST" && { body: JSON.stringify({ json: input }) }),
  });
  const response = await (method === "GET" ? GET : POST)(request);
  const body = (await response.json()) as { result?: { data: { json: unknown } }; error?: { json: { message: string; data: { code: string } } } };
  return { status: response.status, data: body.result?.data.json, error: body.error?.json };
}

const save = (headers: Record<string, string>) => trpc("aiFirst.update", { project: project.slug, email: true, name: "Ada" }, { method: "POST", headers: { cookie: owner.cookie, ...headers } });

test("a cookie mutation from the page's own site saves; from another site it's refused and changes nothing", async () => {
  const before = await aiFirst();
  const others: Record<string, string>[] = [
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
    // A browser that doesn't send Sec-Fetch-Site: by its Origin.
    { origin: "https://evil.example" },
    {},
  ];
  for (const headers of others) {
    expect({ headers, status: (await save(headers)).status }).toEqual({ headers, status: 403 });
  }
  expect(await aiFirst()).toEqual(before);

  expect(await save({ origin: appUrl().origin })).toMatchObject({ status: 200, data: { email: true, name: "Ada" } });
  await prisma.project.update({ where: { id: project.id }, data: { emailAiFirst: false } });
  expect(await save({ "sec-fetch-site": "same-origin" })).toMatchObject({ status: 200, data: { email: true } });
});

test("a portal under a path of the team's site passes the check: its Origin is the site's host, which proxy.ts forwards", async () => {
  expect((await save({ origin: "https://acme.example", "x-forwarded-host": "acme.example" })).status).toBe(200);
  expect((await save({ origin: "https://acme.example", "x-forwarded-host": "other.example" })).status).toBe(403);
});

test("queries change nothing and answer any site; a GET to a mutation is refused", async () => {
  const before = await aiFirst();
  expect(await trpc("aiFirst.get", { project: project.slug }, { headers: { cookie: owner.cookie, "sec-fetch-site": "cross-site" } })).toMatchObject({ status: 200, data: { widget: true } });
  const get = await trpc("aiFirst.update", { project: project.slug, email: true }, { headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" } });
  expect(get.status).toBe(405);
  // A query by POST isn't served either.
  expect((await trpc("aiFirst.get", { project: project.slug }, { method: "POST", headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" } })).status).toBe(405);
  expect(await aiFirst()).toEqual(before);
});

test("a cookie call carrying a proxy's Authorization and no Tuti-Client is still the cookie session", async () => {
  const headers = { cookie: owner.cookie, authorization: "Bearer proxy-added-token", "sec-fetch-site": "same-origin" };
  expect(await trpc("aiFirst.get", { project: project.slug }, { headers })).toMatchObject({ status: 200, data: { widget: true } });
  expect(await save({ authorization: "Basic cHJveHk6cHJveHk=", "sec-fetch-site": "same-origin" })).toMatchObject({ status: 200 });
});

test("the mobile app's token counts only with Tuti-Client; its saves need no same-site check (no cookie)", async () => {
  const token = /session_token=([^;]+)/.exec(owner.cookie)![1]!;
  const app = { authorization: `Bearer ${token}`, "tuti-client": "mobile" };
  expect(await trpc("aiFirst.get", { project: project.slug }, { headers: app })).toMatchObject({ status: 200 });
  expect(await trpc("aiFirst.update", { project: project.slug, name: "Ada" }, { method: "POST", headers: app })).toMatchObject({ status: 200, data: { name: "Ada" } });
  // The token alone, without the header: nobody (the token is only ever a cookie's here).
  expect(await trpc("aiFirst.get", { project: project.slug }, { headers: { authorization: `Bearer ${token}` } })).toMatchObject({ status: 401 });
  expect(await trpc("aiFirst.get", { project: project.slug }, { headers: { authorization: "Bearer not-a-session", "tuti-client": "mobile" } })).toMatchObject({ status: 401 });
});

const tokenHeaders = () => ({ authorization: `Bearer ${/session_token=([^;]+)/.exec(owner.cookie)![1]!}`, "tuti-client": "mobile" });

// Each request counts once against the teammate's rate limit, as /api/v1 counts each call: a batch would run many on one count.
test("the mobile app's token sends one call per request: a batch of them is refused", async () => {
  const input = encodeURIComponent(JSON.stringify({ 0: { json: { project: project.slug } }, 1: { json: { project: project.slug } } }));
  const batch = (headers: Record<string, string>) => GET(new Request(`${appUrl().origin}/api/trpc/aiFirst.get,team.list?batch=1&input=${input}`, { headers: { host: host(), ...headers } }));
  expect((await batch(tokenHeaders())).status).toBe(400);
  // The web app's batches, with its cookie, go through.
  expect((await batch({ cookie: owner.cookie })).status).toBe(200);
});

test("past the token's rate limit, the 429 says when to come back (Retry-After), as /api/v1's does", async () => {
  await prisma.user.update({ where: { id: owner.id }, data: { apiRateCount: 10_000, apiRateWindowStart: new Date(Math.floor(Date.now() / 60_000) * 60_000) } });
  const response = await GET(new Request(`${appUrl().origin}/api/trpc/aiFirst.get?input=${encodeURIComponent(JSON.stringify({ json: { project: project.slug } }))}`, { headers: { host: host(), ...tokenHeaders() } }));
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("an operation's own error keeps its status and message", async () => {
  const long = await save({ "sec-fetch-site": "same-origin" }).then(() =>
    trpc("aiFirst.update", { project: project.slug, name: "x".repeat(51) }, { method: "POST", headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" } }),
  );
  expect(long).toMatchObject({ status: 400, error: { message: "Keep the name under 50 characters", data: { code: "invalid_input" } } });
  const member = await addMember(project.id, "MEMBER");
  expect(await trpc("aiFirst.get", { project: project.slug }, { headers: { cookie: member.cookie } })).toMatchObject({ status: 403 });
  expect(await trpc("aiFirst.get", { project: "p-nobodys" }, { headers: { cookie: owner.cookie } })).toMatchObject({ status: 404 });
  expect(await trpc("aiFirst.get", { project: project.slug })).toMatchObject({ status: 401 });
});

/** What a server component did: rendered, a 404, or a redirect to where. */
async function rendered(page: Promise<unknown>) {
  try {
    await page;
    return "rendered";
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
      return "404";
    }
    if (digest.startsWith("NEXT_REDIRECT;")) {
      return `redirect ${digest.split(";")[2]}`;
    }
    throw error;
  }
}

// Pages read in process through serverCaller(): no same-site check, so a page opened from a bookmark or an email's link
// loads as it always has.
test("a page reads through serverCaller() opened from a bookmark or another site; anyone not allowed gets a 404, nobody the sign-in page", async () => {
  // A server with AI answers (the page is a 404 without): the local fake, asked nothing.
  const model = await startModelFake();
  onTestFinished(async () => {
    await Promise.all([model.embeddings.close(), model.close()]);
  });
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  const page = () => rendered(AiFirstPage({ params: Promise.resolve({ project: project.slug }) } as Parameters<typeof AiFirstPage>[0]));
  actAs(owner);
  for (const site of ["none", "cross-site"]) {
    browser.headers = { "sec-fetch-site": site };
    expect({ site, page: await page() }).toEqual({ site, page: "rendered" });
  }
  actAs(await addMember(project.id, "MEMBER"));
  expect(await page()).toBe("404");
  actAs(await signUp("Someone else"));
  expect(await page()).toBe("404");
  actAs(null);
  expect(await page()).toBe("redirect /app/auth/sign-in");
});

// An unexpected failure (here the database refusing the save) is logged with the names of the fields only, never their
// values (a password, a sign-in link), and answered without its message; a slow call is logged the same way; an
// expected failure (an OperationError, a refusal) isn't logged at all.
test("unexpected failures and slow calls are logged without their input's values; the browser gets no internal detail", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const error = vi.spyOn(log, "error").mockImplementation(() => {});
  onTestFinished(() => {
    warn.mockRestore();
    error.mockRestore();
  });
  const sent = { cookie: owner.cookie, "sec-fetch-site": "same-origin" };
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "test_fail_save"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret detail at db.internal:5432'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_fail_save" BEFORE UPDATE ON "project" FOR EACH ROW WHEN (NEW."aiName" IS DISTINCT FROM OLD."aiName") EXECUTE FUNCTION "test_fail_save"()`);
  try {
    const failed = await trpc("aiFirst.update", { project: project.slug, name: "hunter2" }, { method: "POST", headers: sent });
    expect(failed).toMatchObject({ status: 500, error: { message: "Something went wrong" } });
    expect(JSON.stringify(failed)).not.toContain("secret detail");
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "test_fail_save" ON "project"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "test_fail_save"()`);
  }
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]).toEqual(["tRPC call failed", expect.objectContaining({ path: "aiFirst.update", fields: ["project", "name"] })]);
  expect(JSON.stringify(error.mock.calls[0]![1], (key, value: unknown) => (key === "error" ? undefined : value))).not.toContain("hunter2");

  // Expected failures: not logged.
  await trpc("aiFirst.update", { project: project.slug, name: "x".repeat(51) }, { method: "POST", headers: sent });
  await trpc("aiFirst.get", { project: "p-nobodys" }, { headers: sent });
  expect(error).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();

  // A slow call: SLOW_MS or more between its start and its end.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += SLOW_MS));
  expect((await trpc("aiFirst.update", { project: project.slug, name: "hunter2" }, { method: "POST", headers: sent })).status).toBe(200);
  vi.mocked(performance.now).mockRestore();
  expect(warn).toHaveBeenCalledWith("Slow tRPC call", expect.objectContaining({ path: "aiFirst.update", fields: ["project", "name"] }));
  expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2");
});
