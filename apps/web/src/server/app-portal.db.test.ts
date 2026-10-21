import { NextRequest } from "next/server";
import { beforeEach, expect, test, vi } from "vitest";

import { proxy } from "@/proxy";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { forgetCustomDomain, portalAddress } from "./custom-domains";
import { createPost } from "./operations/create";
import { updatePortal } from "./operations/portal";
import { call } from "./operations/run";

/**
 * Tuti's own portal under its path on the app's domain (APP_PORTAL_PROJECT, tuti.so/help/…): links
 * go there, its Tuti address sends pages there, and a private one asks people to sign in there.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  vi.stubEnv("APP_PORTAL_PROJECT", project.slug);
  // Addresses are kept a few seconds; each test starts afresh.
  forgetCustomDomain("");
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const visit = (host: string, path: string) => proxy(new NextRequest(`http://${host}${path}`, { headers: { host } }));
const app = "tuti.localhost:3100";
const own = () => `http://${app}/${project.slug}`;

test("its address is under its path on the app's domain: links go there, and its Tuti address sends pages there", async () => {
  expect(await portalAddress(project.slug)).toBe(own());
  expect(await call(createPost, as(), { board: "feature-requests", title: "Dark mode" })).toMatchObject({
    url: `${own()}/feedback/feature-requests/dark-mode-1`,
  });
  const moved = await visit(`${project.slug}.localhost:3100`, "/roadmap?x=1");
  expect(moved.status).toBe(308);
  expect(moved.headers.get("location")).toBe(`${own()}/roadmap?x=1`);
  // Its home is under the path too (the app's own / is the app's).
  expect((await visit(`${project.slug}.localhost:3100`, "/")).headers.get("location")).toBe(`${own()}/`);
  // Except to localhost: Next.js would make that redirect a bare path (a loop); the Tuti address shows it then.
  vi.stubEnv("APP_URL", "http://localhost:3100");
  forgetCustomDomain("");
  expect((await visit(`${project.slug}.localhost:3100`, "/roadmap")).headers.get("x-middleware-rewrite")).toBe(
    `http://${project.slug}.localhost:3100/portal/${project.slug}/roadmap`,
  );
  vi.stubEnv("APP_URL", `http://${app}`);
  forgetCustomDomain("");
  // Other projects keep theirs.
  const other = await createProject(owner);
  expect(await portalAddress(other.slug)).toBe(`http://${other.slug}.localhost:3100`);
});

test("private, it sends people to its sign-in under the path, which is the app's", async () => {
  await call(updatePortal, as(), { access: "private" });
  const response = await visit(app, `/${project.slug}/roadmap`);
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(`${own()}/sign-in?next=%2Froadmap`);
  // The team reads it (one account, one session on the app's domain).
  const allowed = await proxy(new NextRequest(`http://${app}/${project.slug}/roadmap`, { headers: { host: app, cookie: owner.cookie } }));
  expect(allowed.headers.get("x-middleware-rewrite")).toBe(`http://${app}/portal/${project.slug}/roadmap`);
});

test("its slug may be a reserved one (help); everyone else's may not", async () => {
  vi.stubEnv("APP_PORTAL_PROJECT", "help");
  const { isReservedSlug } = await import("@/lib/project-slugs");
  expect(isReservedSlug("help")).toBe(false);
  expect(isReservedSlug("docs")).toBe(true);
  vi.stubEnv("APP_PORTAL_PROJECT", "");
  expect(isReservedSlug("help")).toBe(true);
});
