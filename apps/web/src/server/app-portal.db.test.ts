import { prisma } from "@tuti/db";
import { NextRequest } from "next/server";
import { beforeEach, expect, test, vi } from "vitest";

import { proxy } from "@/proxy";
import { actAs, createProject as newProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";

import { forgetCustomDomain, portalAddress } from "./custom-domains";
import { createPost } from "./operations/create";
import { updatePortal } from "./operations/portal";
import { call } from "./operations/run";
import { createProject } from "./projects";

/**
 * Tuti's own portal under its path on the app's domain (APP_PORTAL_PROJECT, tuti.so/help/…): links
 * go there, its Tuti address sends pages there, and a private one asks people to sign in there.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof newProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await newProject(owner);
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
  const other = await newProject(owner);
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

test("its slug may be a reserved one (help), and only its owner (APP_PORTAL_OWNER, verified) can create that project", async () => {
  vi.stubEnv("APP_PORTAL_PROJECT", "help");
  const { isReservedSlug, isUsableSlug } = await import("@/lib/project-slugs");
  // Still reserved for creating projects; used for routing.
  expect(isReservedSlug("help")).toBe(true);
  expect(isUsableSlug("help")).toBe(true);
  expect(isUsableSlug("docs")).toBe(false);

  const form = () => {
    const data = new FormData();
    data.set("name", "Tuti help");
    data.set("slug", "help");
    return data;
  };
  // Not anyone signed in: they could take tuti.so/help before Tuti does.
  const someone = await signUp("Someone");
  actAs(someone);
  expect(await createProject(null as never, form())).toEqual({ error: "That URL is reserved" });
  const maintainer = await signUp("Maintainer");
  vi.stubEnv("APP_PORTAL_OWNER", maintainer.email.toUpperCase());
  actAs(maintainer);
  // Only once the address is verified.
  expect(await createProject(null as never, form())).toEqual({ error: "That URL is reserved" });
  await prisma.user.update({ where: { id: maintainer.id }, data: { emailVerified: true } });
  // Created: the first run's setup.
  expect(await redirectTarget(createProject(null as never, form()))).toBe("/app/help/setup");
});

test("a slug that's one of the app's own paths is ignored (docs would take /docs/api)", async () => {
  vi.stubEnv("APP_PORTAL_PROJECT", "docs");
  const { appPortalMount } = await import("@/lib/app-portal");
  expect(appPortalMount()).toBeNull();
  expect((await visit(app, "/docs/api")).headers.get("x-middleware-rewrite")).toBeNull();
});

test("an ordinary slug named as Tuti's own portal is only its owner's to create, too", async () => {
  vi.stubEnv("APP_PORTAL_PROJECT", "tuti-portal");
  const data = new FormData();
  data.set("name", "Tuti");
  data.set("slug", "tuti-portal");
  actAs(await signUp("Someone"));
  expect(await createProject(null as never, data)).toEqual({ error: "That URL is reserved" });
});

test("the setting is a slug whatever its case, and an app path can't be created even by its owner", async () => {
  vi.stubEnv("APP_PORTAL_PROJECT", " Help ");
  const { isUsableSlug } = await import("@/lib/project-slugs");
  const { appPortalMount } = await import("@/lib/app-portal");
  expect(isUsableSlug("help")).toBe(true);
  expect(appPortalMount()).toMatchObject({ slug: "help", path: "/help" });

  vi.stubEnv("APP_PORTAL_PROJECT", "docs");
  const maintainer = await signUp("Maintainer");
  await prisma.user.update({ where: { id: maintainer.id }, data: { emailVerified: true } });
  vi.stubEnv("APP_PORTAL_OWNER", maintainer.email);
  actAs(maintainer);
  const data = new FormData();
  data.set("name", "Docs");
  data.set("slug", "docs");
  expect(await createProject(null as never, data)).toEqual({ error: "That URL is reserved" });
});
