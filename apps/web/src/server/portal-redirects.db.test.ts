import { prisma } from "@tuti/db";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";

import { proxy } from "@/proxy";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { createRedirect, deleteRedirect, listRedirects } from "./operations/redirects";
import { call } from "./operations/run";
import { removeRedirect, saveRedirect } from "./portal-settings";

/** Customize → Redirects: old addresses on a portal sent on to new ones, by proxy.ts. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const host = () => `${project.slug}.localhost:3100`;
const visit = (path: string, method = "GET") => proxy(new NextRequest(`http://${host()}${path}`, { method, headers: { host: host() } }));
/** Where a visit to `path` goes ("308 <location>"), or "served". */
async function where(path: string, method = "GET") {
  const response = await visit(path, method);
  return response.headers.get("x-middleware-rewrite") ? "served" : `${response.status} ${response.headers.get("location")}`;
}

test("an old address goes to its new one: a path of the portal (with the request's query) or a whole address", async () => {
  await call(createRedirect, as(), { from: "https://old.example.com/hc/en-us/Articles/123-Billing/", to: "/docs/billing" });
  await call(createRedirect, as(), { from: "/pricing", to: "https://acme.example/pricing?from=help" });
  expect(await where("/hc/en-us/articles/123-billing")).toBe(`308 http://${host()}/docs/billing`);
  // Matched lowercase, trailing slash or not, and the query comes along.
  expect(await where("/HC/en-us/articles/123-billing/?ref=mail")).toBe(`308 http://${host()}/docs/billing?ref=mail`);
  expect(await where("/pricing?x=1")).toBe("308 https://acme.example/pricing?from=help");
  expect((await visit("/pricing")).headers.get("cache-control")).toBe("no-store");
  // Everything else is the portal as before; forms aren't sent on.
  expect(await where("/docs/billing")).toBe("served");
  expect(await where("/pricing", "POST")).not.toMatch(/^308/);
  expect((await call(listRedirects, as(), {})).redirects.map((r) => [r.from, r.to])).toEqual([
    ["/pricing", "https://acme.example/pricing?from=help"],
    ["/hc/en-us/articles/123-billing", "/docs/billing"],
  ]);
});

test("deleting one gives the old address back at once", async () => {
  const { redirect } = await call(createRedirect, as(), { from: "/kb/billing", to: "/docs/billing" });
  expect(await where("/kb/billing")).toMatch(/^308 /);
  await call(deleteRedirect, as(), { id: redirect.id });
  expect(await where("/kb/billing")).toBe("served");
  await expect(call(deleteRedirect, as(), { id: redirect.id })).rejects.toMatchObject({ status: 404 });
  // Another project's redirect isn't this one's to delete.
  const other = await createProject(owner);
  const { redirect: theirs } = await call(createRedirect, { ...as(), projectId: other.id }, { from: "/kb/x", to: "/docs" });
  await expect(call(deleteRedirect, as(), { id: theirs.id })).rejects.toMatchObject({ status: 404 });
});

test("one rule per old address, none to itself, no chains (so no circles), not the portal's own addresses", async () => {
  await call(createRedirect, as(), { from: "/a", to: "/b" });
  await expect(call(createRedirect, as(), { from: "/A/", to: "/c" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already has a redirect") });
  await expect(call(createRedirect, as(), { from: "/self", to: "/Self" })).rejects.toMatchObject({ message: "A redirect can't send an address to itself" });
  // b → c would make a → b → c; c → a would make c → a → b.
  await expect(call(createRedirect, as(), { from: "/b", to: "/c" })).rejects.toMatchObject({ message: expect.stringContaining("already part of another redirect") });
  await expect(call(createRedirect, as(), { from: "/c", to: "/a" })).rejects.toMatchObject({ message: expect.stringContaining("already part of another redirect") });
  await expect(call(createRedirect, as(), { from: "/sign-in", to: "/docs" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("portal's own") });
  await expect(call(createRedirect, as(), { from: "/x", to: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
  // A whole address on this portal is a path of it, so the same checks see it.
  await expect(call(createRedirect, as(), { from: "/loop", to: `http://${host()}/loop` })).rejects.toMatchObject({ message: "A redirect can't send an address to itself" });
  await expect(call(createRedirect, as(), { from: "/d", to: `http://${host()}/a` })).rejects.toMatchObject({ message: expect.stringContaining("already part of another redirect") });
  const { redirect } = await call(createRedirect, as(), { from: "/e", to: `http://${host()}/docs?x=1` });
  expect(redirect.to).toBe("/docs?x=1");
});

test("up to 200 per project", async () => {
  await prisma.portalRedirect.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ projectId: project.id, from: `/old/${i}`, to: "/docs" })) });
  await expect(call(createRedirect, as(), { from: "/one-more", to: "/docs" })).rejects.toMatchObject({ message: expect.stringContaining("Up to 200 redirects") });
});

test("Customize's form: admins add and delete them, members can't", async () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      data.set(name, value);
    }
    return data;
  };
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveRedirect(project.slug, {}, form({ from: "/kb", to: "/docs" }))).toEqual({ error: "Only project owners and admins can change the portal's redirects" });
  actAs(owner);
  expect(await saveRedirect(project.slug, {}, form({ from: "/kb", to: "/docs" }))).toEqual({});
  expect(await saveRedirect(project.slug, {}, form({ from: "kb", to: "/docs" }))).toEqual({ error: expect.stringContaining("path") });
  const [rule] = (await call(listRedirects, as(), {})).redirects;
  expect(await removeRedirect(project.slug, rule!.id)).toEqual({});
  expect((await call(listRedirects, as(), {})).redirects).toEqual([]);
});
