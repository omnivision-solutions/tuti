import { prisma } from "@tuti/db";
import { beforeEach, expect, test, vi } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

import { removeDomain, setDomain } from "./operations/domain";
import { call } from "./operations/run";
import { removeSite, setSite } from "./operations/site";

/**
 * A portal has one address of the team's own: a domain (help.example.com) or a path of their site
 * (example.com/portal), not both. To switch, they remove the one they have first.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

test("with a domain, the portal can't also go under a path of the site, until the domain is removed", async () => {
  await call(setDomain, as(), { hostname: "help.example.com" });
  await expect(call(setSite, as(), { url: "https://example.com/portal" })).rejects.toMatchObject({
    status: 409,
    message: "Your portal is on help.example.com. Remove that domain first to put it under a path of your site",
  });
  expect(await prisma.siteMount.count({ where: { projectId: project.id } })).toBe(0);

  await call(removeDomain, as(), {});
  expect((await call(setSite, as(), { url: "https://example.com/portal" })).site.url).toBe("https://example.com/portal");
});

test("under a path of the site, the portal can't also have a domain, until it's removed from the site", async () => {
  await call(setSite, as(), { url: "https://example.com/portal" });
  await expect(call(setDomain, as(), { hostname: "help.example.com" })).rejects.toMatchObject({
    status: 409,
    message: "Your portal is on your site at https://example.com/portal. Remove it there first to give it a domain of its own",
  });
  expect(await prisma.customDomain.count({ where: { projectId: project.id } })).toBe(0);

  await call(removeSite, as(), {});
  expect((await call(setDomain, as(), { hostname: "help.example.com" })).domain.hostname).toBe("help.example.com");
});

test("changing the one it has still works: another domain, or another path", async () => {
  await call(setDomain, as(), { hostname: "help.example.com" });
  expect((await call(setDomain, as(), { hostname: "docs.example.com" })).domain.hostname).toBe("docs.example.com");
  await call(removeDomain, as(), {});
  await call(setSite, as(), { url: "https://example.com/portal" });
  expect((await call(setSite, as(), { url: "https://example.com/help" })).site.url).toBe("https://example.com/help");
});

test("both added at the same moment: only one of them is kept", async () => {
  const results = await Promise.allSettled([
    call(setDomain, as(), { hostname: "help.example.com" }),
    call(setSite, as(), { url: "https://example.com/portal" }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const [domains, mounts] = await Promise.all([
    prisma.customDomain.count({ where: { projectId: project.id } }),
    prisma.siteMount.count({ where: { projectId: project.id } }),
  ]);
  expect(domains + mounts).toBe(1);
});
