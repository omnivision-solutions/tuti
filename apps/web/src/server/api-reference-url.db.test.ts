import { prisma } from "@tuti/db";
import { fetchSpec, handlers, syncBudget, SPEC_FETCH_TIMEOUT_MS, SPEC_URL_TOO_LARGE, syncApiReferences, SYNC_EVERY_MS, SYNC_ROWS_PER_HOST } from "@tuti/jobs";
import { OPENAPI_MAX_BYTES } from "@tuti/shared/api-reference";
import { type ApiFake, type SiteFake, startApiFake, startSiteFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import * as actions from "./api-references";
import {
  countSpecFetch,
  createApiReference,
  FETCHES_PER_MEMBER_PER_MINUTE,
  FETCHES_PER_PROJECT_PER_HOUR,
  getApiReference,
  syncApiReference,
  updateApiReference,
} from "./operations/api-references";
import { call } from "./operations/run";

/**
 * API references read from a URL (docs/plan.md, API reference in Docs, A10): added from an address, synced on Sync now
 * and every 6 hours, with the team's choices kept and a failed read keeping the pages; and the limits on what Tuti
 * fetches. Specs come from local fakes (`startSiteFake`, `startApiFake`); names resolve from fixed answers here, so
 * nothing reaches the network.
 */

/** The answers connections get (publicOnlyLookup's). */
const CONNECT: Record<string, string> = {
  "internal.acme.test": "10.0.0.5",
  "metadata.acme.test": "169.254.169.254",
  "busy.acme.test": "10.0.0.6",
  "other.acme.test": "10.0.0.7",
  "short.acme.test": "10.0.0.8",
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

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let site: SiteFake;
let api: ApiFake;

beforeAll(async () => {
  [site, api] = await Promise.all([startSiteFake(), startApiFake({ cors: false })]);
});
afterAll(async () => {
  await Promise.all([site.close(), api.close()]);
});
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const PRIVATE = "Tuti reads specs only from public addresses.";

/** An OpenAPI spec with these operations ("GET /posts": its tag), its server relative to where it's served. */
function spec(operations: Record<string, string>) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, tag] of Object.entries(operations)) {
    const [method, path] = key.split(" ") as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = { tags: [tag], summary: key, responses: { 200: { description: "OK" } } };
  }
  return JSON.stringify({ openapi: "3.1.0", info: { title: "Acme API", version: "1" }, servers: [{ url: "/v1" }, { url: "/{version}", variables: { version: { default: "v2" } } }], paths });
}
const POSTS = spec({ "GET /posts": "Posts", "DELETE /posts": "Admin" });

/** A reference read from the site's `path`, served `text` (null: the site's 404). */
async function addFromUrl(text: string | null = POSTS, path = "/openapi.json") {
  site.answer(path, text);
  return call(createApiReference, as(), { name: "Acme API", url: `${site.origin}${path}` });
}
const sync = () => call(syncApiReference, as(), { slug: "acme-api" });
const stored = () => prisma.apiReference.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: "acme-api" } } });
const keys = async () => (await call(getApiReference, as(), { slug: "acme-api" })).operations.map((o) => [o.key, ...(o.onHelpCenter ? [] : ["off"]), ...(o.new ? ["new"] : [])].join(" "));

describe("added from a URL", () => {
  beforeEach(() => vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true"));

  test("the spec at the address is read and kept, the address is its source, and relative servers are on it", async () => {
    expect(await addFromUrl()).toMatchObject({ slug: "acme-api", source: "url", sourceUrl: `${site.origin}/openapi.json`, syncError: null });
    const row = await stored();
    expect(row.spec).toBe(POSTS);
    const doc = row.doc as { servers: { url: string }[]; warnings: { code: string }[] };
    expect(doc.servers.map((server) => server.url)).toEqual([`${site.origin}/v1`, `${site.origin}/{version}`]);
    expect(doc.warnings.map((warning) => warning.code)).not.toContain("RELATIVE_SERVER");
    // An uploaded spec's relative server stays as written: nothing says where it was.
    await call(createApiReference, as(), { name: "Uploaded", spec: POSTS });
    const uploaded = await prisma.apiReference.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug: "uploaded" } } });
    expect((uploaded.doc as { servers: { url: string }[] }).servers[0]!.url).toBe("/v1");
  });

  test("an address refused before anything is fetched doesn't count against the limit", async () => {
    actAs(owner);
    // Without WEBHOOK_ALLOW_PRIVATE_URLS here: http and private addresses are refused as they are in production.
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
    const refused = ["not an address", "http://example.com/openapi.json", "https://user:secret@example.com/openapi.json", "https://10.0.0.5/openapi.json"];
    for (let at = 0; at < FETCHES_PER_MEMBER_PER_MINUTE; at++) {
      for (const address of refused) {
        expect(await actions.previewApiReferenceUrl(project.slug, address)).toMatchObject({ error: expect.any(String) });
      }
    }
    await expect(call(createApiReference, as(), { name: "Typo", url: "http://example.com/openapi.json" })).rejects.toMatchObject({ status: 400 });
    // A URL's reference whose address is refused now syncs to its reason, uncounted.
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    await addFromUrl();
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
    expect(await sync()).toMatchObject({ changes: null, syncError: "Enter an address that starts with https://" });
    // Only the add fetched anything.
    expect(await prisma.apiReferenceFetch.count({ where: { userId: owner.id } })).toBe(1);
  });

  test("a member's fetches count across their projects, and fetches at once can't overrun the limit together", async () => {
    actAs(owner);
    const other = await createProject(owner);
    await prisma.apiReferenceFetch.createMany({ data: Array.from({ length: FETCHES_PER_MEMBER_PER_MINUTE }, () => ({ projectId: other.id, userId: owner.id })) });
    expect(await actions.previewApiReferenceUrl(project.slug, `${site.origin}/missing.json`)).toEqual({ error: "That's a lot of fetches. Try again in a minute." });
    await prisma.apiReferenceFetch.deleteMany({});
    const counted = await Promise.allSettled(Array.from({ length: 15 }, () => countSpecFetch(as())));
    expect(counted.filter((result) => result.status === "fulfilled")).toHaveLength(FETCHES_PER_MEMBER_PER_MINUTE);
    expect(await prisma.apiReferenceFetch.count({ where: { userId: owner.id } })).toBe(FETCHES_PER_MEMBER_PER_MINUTE);
  });

  test("relative servers are on the address that served the spec, after its redirects", async () => {
    const text = JSON.stringify({ ...JSON.parse(POSTS), servers: [{ url: "v1" }, { url: "./v2" }] });
    site.answer("/docs/openapi.json", text);
    const moved = `${api.origin}/redirect?to=${encodeURIComponent(`${site.origin}/docs/openapi.json`)}`;
    expect(await call(createApiReference, as(), { name: "Acme API", url: moved })).toMatchObject({ sourceUrl: moved });
    expect(((await stored()).doc as { servers: { url: string }[] }).servers.map((server) => server.url)).toEqual([`${site.origin}/docs/v1`, `${site.origin}/docs/v2`]);
    // A sync reads it the same way.
    site.answer("/docs/openapi.json", text.replace('"v1"', '"v3"'));
    await sync();
    expect(((await stored()).doc as { servers: { url: string }[] }).servers[0]!.url).toBe(`${site.origin}/docs/v3`);
  });

  test("a relative server that can't be on any address is kept as written, with its warning", async () => {
    await addFromUrl(JSON.stringify({ ...JSON.parse(POSTS), servers: [{ url: "//" }, { url: "/v1" }] }));
    const doc = (await stored()).doc as { servers: { url: string }[]; warnings: { code: string; where: string }[] };
    expect(doc.servers.map((server) => server.url)).toEqual(["//", `${site.origin}/v1`]);
    expect(doc.warnings.filter((warning) => warning.code === "RELATIVE_SERVER").map((warning) => warning.where)).toEqual([expect.stringMatching(/ › \/\/$/)]);
  });

  test("fetches the team asks for are limited per member a minute and per project an hour; the 6-hourly sync isn't", async () => {
    actAs(owner);
    const missing = `${site.origin}/missing.json`;
    for (let at = 0; at < FETCHES_PER_MEMBER_PER_MINUTE; at++) {
      expect(await actions.previewApiReferenceUrl(project.slug, missing)).toEqual({ error: "The address answered 404 Not Found." });
    }
    expect(await actions.previewApiReferenceUrl(project.slug, missing)).toEqual({ error: "That's a lot of fetches. Try again in a minute." });
    await expect(addFromUrl()).rejects.toMatchObject({ status: 429 });
    // A minute on, the member may again, while the project has room.
    await prisma.apiReferenceFetch.updateMany({ where: { projectId: project.id }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    await addFromUrl();
    expect((await sync()).changes).toEqual({ added: 0, removed: 0, changed: false });
    // The project's hour is full of teammates' fetches: Sync now waits, the job doesn't.
    await prisma.apiReferenceFetch.createMany({
      data: Array.from({ length: FETCHES_PER_PROJECT_PER_HOUR }, () => ({ projectId: project.id, userId: "a-teammate" })),
    });
    await expect(sync()).rejects.toMatchObject({ status: 429, message: "This project fetched a lot of specs in the last hour. Try again later." });
    expect(await actions.syncApiReferenceNow(project.slug, "acme-api")).toEqual({ error: "This project fetched a lot of specs in the last hour. Try again later." });
    await prisma.apiReference.update({ where: { projectId_slug: { projectId: project.id, slug: "acme-api" } }, data: { syncTriedAt: new Date(0) } });
    await prisma.apiReference.updateMany({ where: { projectId: { not: project.id } }, data: { syncTriedAt: new Date() } });
    expect(await handlers.syncApiReferences({}, { info: () => {}, warn: () => {} })).toEqual({ synced: 1, failed: 0 });
    // Another project's hour is its own.
    const other = await createProject(owner);
    await call(createApiReference, { actor: { kind: "user", userId: owner.id }, projectId: other.id }, { name: "Acme API", url: `${site.origin}/openapi.json` });
  });

  test("an address that can't be read, or isn't a spec with operations, adds nothing; nor does both a spec and an address", async () => {
    await expect(addFromUrl(null)).rejects.toMatchObject({ status: 400, message: "The address answered 404 Not Found." });
    await expect(addFromUrl("hello there")).rejects.toMatchObject({ status: 400 });
    await expect(addFromUrl(spec({}))).rejects.toMatchObject({ message: "This spec has no operations to show." });
    await expect(call(createApiReference, as(), { name: "Both", spec: POSTS, url: `${site.origin}/openapi.json` })).rejects.toMatchObject({ status: 400 });
    await expect(call(createApiReference, as(), { name: "Neither" })).rejects.toMatchObject({ status: 400 });
    expect(await prisma.apiReference.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("the dialog's Fetch reads the address for its name, or says why it can't be added; the add says which field", async () => {
    actAs(owner);
    site.answer("/preview.json", POSTS);
    expect(await actions.previewApiReferenceUrl(project.slug, `${site.origin}/preview.json`)).toEqual({ suggests: "Acme API" });
    expect(await actions.previewApiReferenceUrl(project.slug, `${site.origin}/nothing.json`)).toEqual({ error: "The address answered 404 Not Found." });
    expect(await actions.previewApiReferenceUrl(project.slug, "not an address")).toEqual({ error: "Enter a full address, like https://example.com/openapi.json" });
    const { addApiReference } = await import("./docs");
    const form = new FormData();
    form.set("name", "Acme API");
    form.set("url", `${site.origin}/nothing.json`);
    expect(await addApiReference(project.slug, form)).toEqual({ error: "The address answered 404 Not Found.", field: "url" });
    form.set("url", `${site.origin}/preview.json`);
    expect(await addApiReference(project.slug, form)).toEqual({ slug: "acme-api" });
  });
});

describe("a sync", () => {
  beforeEach(async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    await addFromUrl();
  });

  test("reads the address again: the team's choices stay, and what's new is new (off, as something is hidden)", async () => {
    await call(updateApiReference, as(), { slug: "acme-api", hideGroups: ["Admin"], seen: true });
    const before = await stored();
    site.answer("/openapi.json", spec({ "GET /posts": "Posts", "DELETE /posts": "Admin", "GET /users": "Users" }));
    expect((await sync()).changes).toEqual({ added: 1, removed: 0, changed: true });
    expect(await keys()).toEqual(["GET /posts", "DELETE /posts off", "GET /users off new"]);
    const after = await stored();
    expect(after.syncedAt.getTime()).toBeGreaterThan(before.syncedAt.getTime());
    expect(after.syncTriedAt.getTime()).toBeGreaterThan(before.syncTriedAt.getTime());
    // The same again: nothing changed.
    expect((await sync()).changes).toEqual({ added: 0, removed: 0, changed: false });
  });

  test("one that fails keeps the pages and says why until one works; Sync now's answers for the toast", async () => {
    actAs(owner);
    const before = await stored();
    site.answer("/openapi.json", null);
    expect(await sync()).toMatchObject({ changes: null, syncError: "The address answered 404 Not Found." });
    expect(await actions.syncApiReferenceNow(project.slug, "acme-api")).toEqual({ error: "The address answered 404 Not Found." });
    // A spec with nothing to show is a failure too.
    site.answer("/openapi.json", spec({}));
    expect(await sync()).toMatchObject({ changes: null, syncError: "This spec has no operations to show." });
    const failed = await stored();
    expect({ doc: failed.doc, spec: failed.spec, syncedAt: failed.syncedAt }).toEqual({ doc: before.doc, spec: before.spec, syncedAt: before.syncedAt });
    expect(failed.syncTriedAt.getTime()).toBeGreaterThan(before.syncTriedAt.getTime());
    expect(await keys()).toEqual(["GET /posts", "DELETE /posts"]);
    site.answer("/openapi.json", spec({ "GET /posts": "Posts" }));
    expect(await actions.syncApiReferenceNow(project.slug, "acme-api")).toEqual({ added: 0, removed: 1, changed: true });
    expect((await stored()).syncError).toBeNull();
  });

  test("of two syncs at once, the one that finishes second writes nothing: its answer is older", async () => {
    const NEW = spec({ "GET /posts": "Posts", "DELETE /posts": "Admin", "GET /users": "Users" });
    // The first sync's request waits at the site while a second runs whole and reads NEW; then the first is answered.
    const overtaken = async (late: string | null) => {
      let second: Awaited<ReturnType<typeof sync>> | undefined;
      site.during(async () => {
        site.answer("/openapi.json", NEW);
        second = await sync();
        site.answer("/openapi.json", late);
      });
      const first = await sync();
      return { first, second: second! };
    };
    // A stale error doesn't replace the success.
    const { first, second } = await overtaken(null);
    expect(second).toMatchObject({ changes: { added: 1, removed: 0, changed: true }, syncError: null });
    expect(first).toMatchObject({ changes: null, syncError: null });
    expect(await keys()).toEqual(["GET /posts", "DELETE /posts", "GET /users new"]);
    // Nor does a stale spec replace the newer one.
    const again = await overtaken(POSTS);
    expect(again.first.changes).toBeNull();
    expect(await keys()).toEqual(["GET /posts", "DELETE /posts", "GET /users new"]);
    expect((await stored()).spec).toBe(NEW);
  });

  test("Settings changes the address: the new one is read before it's kept; one that can't be leaves it as it was", async () => {
    actAs(owner);
    await call(updateApiReference, as(), { slug: "acme-api", hideGroups: ["Admin"] });
    const before = await prisma.apiReferenceFetch.count({ where: { userId: owner.id } });
    // Refused before anything is fetched: uncounted, nothing changes.
    expect(await actions.changeApiReferenceUrl(project.slug, "acme-api", "ftp://example.com/openapi.json")).toEqual({ error: "Enter an address that starts with https://" });
    // Fetched and can't be read: counted, nothing changes.
    expect(await actions.changeApiReferenceUrl(project.slug, "acme-api", `${site.origin}/moved.json`)).toEqual({ error: "The address answered 404 Not Found." });
    expect(await stored()).toMatchObject({ sourceUrl: `${site.origin}/openapi.json`, syncError: null });
    expect(await prisma.apiReferenceFetch.count({ where: { userId: owner.id } })).toBe(before + 1);
    // Read: kept, its spec read in with the team's choices, and the address it's synced from from now on.
    site.answer("/v2/moved.json", JSON.stringify({ ...JSON.parse(spec({ "GET /posts": "Posts", "DELETE /posts": "Admin", "GET /users": "Users" })), servers: [{ url: "v1" }] }));
    expect(await actions.changeApiReferenceUrl(project.slug, "acme-api", `${site.origin}/v2/moved.json`)).toEqual({ added: 1, removed: 0, changed: true });
    const row = await stored();
    expect(row.sourceUrl).toBe(`${site.origin}/v2/moved.json`);
    expect((row.doc as { servers: { url: string }[] }).servers[0]!.url).toBe(`${site.origin}/v2/v1`);
    expect(await keys()).toEqual(["GET /posts", "DELETE /posts off", "GET /users off new"]);
    site.answer("/openapi.json", null);
    expect((await sync()).syncError).toBeNull();
    expect(await prisma.apiReferenceFetch.count({ where: { userId: owner.id } })).toBe(before + 3);
  });

  test("of two address changes at once, the one that finishes second is refused: the other's address and spec stay", async () => {
    site.answer("/a.json", spec({ "GET /posts": "Posts", "GET /a": "A" }));
    site.answer("/b.json", spec({ "GET /posts": "Posts", "GET /b": "B" }));
    const change = (path: string) => call(syncApiReference, as(), { slug: "acme-api", url: `${site.origin}${path}` });
    // The change to A waits at the site while a teammate's change to B runs whole.
    let second: Awaited<ReturnType<typeof change>> | undefined;
    site.during(async () => {
      second = await change("/b.json");
    });
    await expect(change("/a.json")).rejects.toMatchObject({ status: 409, message: "Someone changed the address meanwhile. Reload to see it, and try again." });
    expect(second).toMatchObject({ sourceUrl: `${site.origin}/b.json`, changes: { added: 1, removed: 1, changed: true } });
    expect(await stored()).toMatchObject({ sourceUrl: `${site.origin}/b.json`, spec: spec({ "GET /posts": "Posts", "GET /b": "B" }) });
  });

  test("Settings' Change to the address it already has syncs it, and says so when that fails", async () => {
    actAs(owner);
    site.answer("/openapi.json", null);
    expect(await actions.changeApiReferenceUrl(project.slug, "acme-api", `${site.origin}/openapi.json`)).toEqual({ error: "The address answered 404 Not Found." });
    site.answer("/openapi.json", POSTS);
    expect(await actions.changeApiReferenceUrl(project.slug, "acme-api", `${site.origin}/openapi.json`)).toEqual({ added: 0, removed: 0, changed: false });
  });

  test("an uploaded reference isn't synced, and a URL's isn't replaced by hand", async () => {
    await call(createApiReference, as(), { name: "Uploaded", spec: POSTS });
    await expect(call(syncApiReference, as(), { slug: "uploaded" })).rejects.toMatchObject({ status: 409 });
    await expect(call((await import("./operations/api-references")).replaceApiReference, as(), { slug: "acme-api", spec: POSTS })).rejects.toMatchObject({ status: 409 });
  });
});

describe("what Tuti fetches", () => {
  test("https only, and no credentials in the address", async () => {
    await expect(call(createApiReference, as(), { name: "Acme API", url: "http://example.com/openapi.json" })).rejects.toMatchObject({
      message: "Enter an address that starts with https://",
    });
    expect(await fetchSpec("ftp://example.com/openapi.json")).toEqual({ error: "Enter an address that starts with https://" });
    expect(await fetchSpec("https://user:secret@example.com/openapi.json")).toEqual({ error: "Leave credentials out of the address: Tuti reads public specs only." });
  });

  test("public addresses only: an IP address, and a name, checked on the address connected to", async () => {
    await expect(call(createApiReference, as(), { name: "Acme API", url: "https://10.0.0.5/openapi.json" })).rejects.toMatchObject({ message: PRIVATE });
    expect(await fetchSpec("https://[::1]/openapi.json")).toEqual({ error: PRIVATE });
    expect(await fetchSpec("https://internal.acme.test/openapi.json")).toEqual({ error: PRIVATE });
    expect(await fetchSpec("https://metadata.acme.test/latest")).toEqual({ error: PRIVATE });
    expect(await fetchSpec("https://nowhere.acme.test/openapi.json")).toEqual({ error: "nowhere.acme.test can't be found." });
  });

  test("each redirect is checked as the first address, and only a few are followed", async () => {
    site.answer("/openapi.json", POSTS);
    // Tests only: the fakes on this machine count as public, over http.
    const local = { allowLoopback: true };
    const redirect = (to: string) => `${api.origin}/redirect?to=${encodeURIComponent(to)}`;
    expect(await fetchSpec(redirect(`${site.origin}/openapi.json`), local)).toEqual({ text: POSTS, url: `${site.origin}/openapi.json` });
    expect(await fetchSpec(redirect("https://internal.acme.test/openapi.json"), local)).toEqual({ error: PRIVATE });
    expect(await fetchSpec(redirect("https://169.254.169.254/latest"), local)).toEqual({ error: PRIVATE });
    expect(await fetchSpec(redirect("http://example.com/openapi.json"), local)).toEqual({ error: "Enter an address that starts with https://" });
    const three = redirect(redirect(redirect(`${site.origin}/openapi.json`)));
    expect(await fetchSpec(three, local)).toEqual({ text: POSTS, url: `${site.origin}/openapi.json` });
    expect(await fetchSpec(redirect(three), local)).toEqual({ error: "The address redirected too many times." });
  });

  test("5 MB at most, read no further", async () => {
    const local = { allowLoopback: true };
    site.answer("/huge.json", "x".repeat(OPENAPI_MAX_BYTES + 1));
    expect(await fetchSpec(`${site.origin}/huge.json`, local)).toEqual({ error: SPEC_URL_TOO_LARGE });
    site.answer("/just.json", "x".repeat(OPENAPI_MAX_BYTES));
    expect(await fetchSpec(`${site.origin}/just.json`, local)).toEqual({ text: "x".repeat(OPENAPI_MAX_BYTES), url: `${site.origin}/just.json` });
  });

  test("gives up on an address that doesn't answer within the time limit", async () => {
    // The limit as asked for, run short so the test needn't wait 15 seconds.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const asked = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(200));
    expect(await fetchSpec(`${api.origin}/stall`, { allowLoopback: true })).toEqual({ error: "The address didn't answer within 15 seconds." });
    expect(asked).toHaveBeenCalledWith(SPEC_FETCH_TIMEOUT_MS);
    asked.mockRestore();
  });

  test("sends nothing of ours: no cookies or credentials", async () => {
    await fetchSpec(`${api.origin}/spec`, { allowLoopback: true });
    const sent = api.requests.at(-1)!;
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["user-agent"]).toBe("Tuti-API-Reference/1");
  });
});

describe("the 6-hourly job", () => {
  const log = { info: () => {}, warn: () => {} };

  test("syncs the URL references last tried over 6 hours ago; one failing stops none of the others", async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    const stale = new Date(Date.now() - SYNC_EVERY_MS - 60_000);
    const add = async (name: string, path: string, triedAt: Date, url = true) => {
      site.answer(path, POSTS);
      const made = await call(createApiReference, as(), url ? { name, url: `${site.origin}${path}` } : { name, spec: POSTS });
      await prisma.apiReference.update({ where: { projectId_slug: { projectId: project.id, slug: made.slug } }, data: { syncTriedAt: triedAt } });
      return made.slug;
    };
    // Other projects' references from earlier tests are due too: only this project's are looked at here.
    await prisma.apiReference.updateMany({ where: { projectId: { not: project.id } }, data: { syncTriedAt: new Date() } });
    const [failing, works, fresh, uploaded] = [
      await add("Failing", "/failing.json", new Date(stale.getTime() - 1000)),
      await add("Works", "/works.json", stale),
      await add("Fresh", "/fresh.json", new Date(Date.now() - 60 * 60_000)),
      await add("Uploaded", "/uploaded.json", stale, false),
    ];
    const NEW = spec({ "GET /posts": "Posts", "DELETE /posts": "Admin", "GET /users": "Users" });
    site.answer("/failing.json", null);
    for (const path of ["/works.json", "/fresh.json", "/uploaded.json"]) site.answer(path, NEW);

    expect(await handlers.syncApiReferences({}, log)).toEqual({ synced: 1, failed: 1 });
    const row = (slug: string) => prisma.apiReference.findUniqueOrThrow({ where: { projectId_slug: { projectId: project.id, slug } } });
    expect((await row(works)).operationCount).toBe(3);
    expect(await row(failing)).toMatchObject({ syncError: "The address answered 404 Not Found.", operationCount: 2 });
    expect((await row(fresh)).operationCount).toBe(2);
    expect((await row(uploaded)).operationCount).toBe(2);
    // Tried now: not again until 6 hours on.
    expect(await handlers.syncApiReferences({}, log)).toEqual({ synced: 0, failed: 0 });
  });

  test("one host's backlog never keeps another host's reference waiting: a run takes each host's oldest, a host bounded by time", async () => {
    const now = new Date();
    await prisma.apiReference.updateMany({ data: { syncTriedAt: now } });
    const made = await call(createApiReference, as(), { name: "Template", spec: POSTS });
    const { doc, state, ...rest } = await prisma.apiReference.findUniqueOrThrow({
      where: { projectId_slug: { projectId: project.id, slug: made.slug } },
      select: { projectId: true, tabId: true, name: true, format: true, spec: true, doc: true, state: true },
    });
    // Two made-up hosts the fixed answers send to private addresses: every read is refused before it leaves, the
    // same way each time, and still counts as tried. More due on the busy one than a run looks at in all, every one
    // older than the other host's one.
    const due = (minutes: number) => new Date(now.getTime() - SYNC_EVERY_MS - minutes * 60_000);
    const backlog = 5_001;
    await prisma.apiReference.createMany({
      data: [
        ...Array.from({ length: backlog }, (_, at) => ({ slug: `busy-${at}`, sourceUrl: `https://BUSY.acme.test:443/${at}.json`, syncTriedAt: due(backlog + 10 - at) })),
        { slug: "other", sourceUrl: "https://other.acme.test/openapi.json", syncTriedAt: due(1) },
      ].map((row) => ({ ...rest, ...row, source: "URL" as const, doc: doc as object, state: state as object })),
    });

    const run = new Date();
    expect(await handlers.syncApiReferences({}, log)).toEqual({ synced: 0, failed: SYNC_ROWS_PER_HOST + 1 });
    const tried = await prisma.apiReference.findMany({ where: { projectId: project.id, syncTriedAt: { gte: run } }, select: { slug: true, syncError: true } });
    // The other host's, and the busy host's oldest, as many as a run takes of one host (its name in any case, any port).
    expect(tried.map((row) => row.slug).sort()).toEqual([...Array.from({ length: SYNC_ROWS_PER_HOST }, (_, at) => `busy-${at}`), "other"].sort());
    expect(new Set(tried.map((row) => row.syncError))).toEqual(new Set([PRIVATE]));
  }, 60_000);

  test("hosts share a run: one with a single reference is read though busy hosts' backlogs outlast the budget", async () => {
    const now = new Date();
    await prisma.apiReference.updateMany({ data: { syncTriedAt: now } });
    const made = await call(createApiReference, as(), { name: "Template", spec: POSTS });
    const { doc, state, ...rest } = await prisma.apiReference.findUniqueOrThrow({
      where: { projectId_slug: { projectId: project.id, slug: made.slug } },
      select: { projectId: true, tabId: true, name: true, format: true, spec: true, doc: true, state: true },
    });
    // Four busy hosts, 20 due each and all older than the single host's one: every read refused at once by the fixed answers.
    const due = (minutes: number) => new Date(now.getTime() - SYNC_EVERY_MS - minutes * 60_000);
    const busy = ["internal", "metadata", "busy", "other"].flatMap((host) =>
      Array.from({ length: 20 }, (_, at) => ({ slug: `${host}-${at}`, sourceUrl: `https://${host}.acme.test/${at}.json`, syncTriedAt: due(100 - at) })),
    );
    await prisma.apiReference.createMany({
      data: [...busy, { slug: "single", sourceUrl: "https://short.acme.test/openapi.json", syncTriedAt: due(1) }].map((row) => ({
        ...rest,
        ...row,
        source: "URL" as const,
        doc: doc as object,
        state: state as object,
      })),
    });
    // A budget of 8 reads: far less than the backlog, and the single host still gets one.
    let reads = 0;
    expect(await syncApiReferences({}, log, new Date(), () => reads++ >= 8)).toEqual({ synced: 0, failed: 8 });
    const tried = await prisma.apiReference.findMany({ where: { projectId: project.id, syncTriedAt: { gt: now } }, select: { slug: true } });
    expect(tried.map((row) => row.slug)).toContain("single");
    // And each busy host had its turns, two reads each at most.
    for (const host of ["internal", "metadata", "busy", "other"]) {
      expect(tried.filter((row) => row.slug.startsWith(`${host}-`)).length).toBeLessThanOrEqual(2);
    }
  });

  test("a run's window takes each host's first before any host's second: busy hosts' older backlogs don't fill it", async () => {
    const now = new Date();
    await prisma.apiReference.updateMany({ data: { syncTriedAt: now } });
    const made = await call(createApiReference, as(), { name: "Template", spec: POSTS });
    const { doc, state, ...rest } = await prisma.apiReference.findUniqueOrThrow({
      where: { projectId_slug: { projectId: project.id, slug: made.slug } },
      select: { projectId: true, tabId: true, name: true, format: true, spec: true, doc: true, state: true },
    });
    // Four busy hosts, five due each and every one older than the single host's: more than a window of 6 holds.
    const due = (minutes: number) => new Date(now.getTime() - SYNC_EVERY_MS - minutes * 60_000);
    // No two share a time, so the order is the ages' alone: internal's are the oldest at each place.
    const busy = ["internal", "metadata", "busy", "other"].flatMap((host, index) =>
      Array.from({ length: 5 }, (_, at) => ({ slug: `${host}-${at}`, sourceUrl: `https://${host}.acme.test/${at}.json`, syncTriedAt: due(100 - at * 10 - index) })),
    );
    await prisma.apiReference.createMany({
      data: [...busy, { slug: "single", sourceUrl: "https://short.acme.test/openapi.json", syncTriedAt: due(1) }].map((row) => ({
        ...rest,
        ...row,
        source: "URL" as const,
        doc: doc as object,
        state: state as object,
      })),
    });
    expect(await syncApiReferences({}, log, new Date(), () => false, 6)).toEqual({ synced: 0, failed: 6 });
    const tried = (await prisma.apiReference.findMany({ where: { projectId: project.id, source: "URL", syncTriedAt: { gt: now } }, select: { slug: true } })).map((row) => row.slug);
    // Each host's oldest, and the oldest host's second.
    expect(tried.sort()).toEqual(["busy-0", "internal-0", "internal-1", "metadata-0", "other-0", "single"]);
  });

  test("a run starts no read past its time budget: the rest wait for the next", async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    await prisma.apiReference.updateMany({ data: { syncTriedAt: new Date() } });
    await addFromUrl();
    await prisma.apiReference.updateMany({ where: { projectId: project.id }, data: { syncTriedAt: new Date(0) } });
    expect(await syncApiReferences({}, log, new Date(), syncBudget(0))).toEqual({ synced: 0, failed: 0 });
    expect((await stored()).syncTriedAt).toEqual(new Date(0));
    expect(await syncApiReferences({}, log)).toEqual({ synced: 1, failed: 0 });
  });
});
