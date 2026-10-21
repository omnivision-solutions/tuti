import { prisma } from "@tuti/db";
import { type SiteFake, startSiteFake } from "@tuti/testkit";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { proxy } from "@/proxy";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { portalAddress } from "./custom-domains";
import { createPost } from "./operations/create";
import { getSite, removeSite, setSite, verifySite } from "./operations/site";
import { call } from "./operations/run";

/**
 * Putting the portal under a path of the team's site: they set the address, make the site forward
 * the path to the portal's Tuti address, and check it; once verified, it's the portal's address.
 */

let site: SiteFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  site = await startSiteFake();
});
afterAll(() => site.close());

beforeEach(async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const tuti = () => `${project.slug}.localhost:3100`;
const visit = (path: string) => proxy(new NextRequest(`http://${tuti()}${path}`, { headers: { host: tuti() } }));
/** What the team's site does once it forwards the path: the portal's Tuti address answers the check, so the site does too. */
async function forwardCheck(path = "/portal") {
  const response = await visit(`${path}/.well-known/tuti-site`);
  site.answer(`${path}/.well-known/tuti-site`, response.status === 200 ? await response.text() : null);
}

test("set as pasted, with what to forward; checked through the site; then it's the portal's address", async () => {
  const { site: pending } = await call(setSite, as(), { url: ` ${site.origin}/Portal/ ` });
  expect(pending).toEqual({
    url: `${site.origin}/portal`,
    status: "pending",
    verifiedAt: null,
    // The path, and Next.js's files (pages load them from /_tuti).
    forward: [
      { from: "/portal/*", to: `http://${tuti()}/portal/*` },
      { from: "/_tuti/*", to: `http://${tuti()}/_tuti/*` },
    ],
    check: { url: `${site.origin}/portal/.well-known/tuti-site`, token: expect.stringMatching(/^tuti-site=[0-9a-f]{32}$/) },
  });
  expect(await call(getSite, as(), {})).toEqual({ site: pending });

  // Not forwarded yet: the site's own 404.
  await expect(call(verifySite, as(), {})).rejects.toMatchObject({ status: 400, message: expect.stringContaining("didn't answer with this portal's check") });
  // Something else there.
  site.answer("/portal/.well-known/tuti-site", "tuti-site=someone-elses");
  await expect(call(verifySite, as(), {})).rejects.toMatchObject({ status: 400 });
  expect(await portalAddress(project.slug)).toBe(`http://${tuti()}`);

  // The Tuti address answers the check under the path (verified or not); the site forwards it.
  await forwardCheck();
  expect((await call(verifySite, as(), {})).site).toMatchObject({ status: "verified" });
  expect(await portalAddress(project.slug)).toBe(`${site.origin}/portal`);
  expect(await call(createPost, as(), { board: "feature-requests", title: "Dark mode" })).toMatchObject({
    url: `${site.origin}/portal/feedback/feature-requests/dark-mode-1`,
  });
  // Its Tuti address sends people there, with the path.
  const moved = await visit("/roadmap?x=1");
  expect(moved.status).toBe(308);
  expect(moved.headers.get("location")).toBe(`${site.origin}/portal/roadmap?x=1`);

  await call(removeSite, as(), {});
  expect(await portalAddress(project.slug)).toBe(`http://${tuti()}`);
  expect(await call(getSite, as(), {})).toEqual({ site: null });
  await expect(call(verifySite, as(), {})).rejects.toMatchObject({ status: 404 });
});

test("the check: only for this project's path, and a site that isn't there fails it", async () => {
  await call(setSite, as(), { url: `${site.origin}/portal` });
  // Another path is just a page of the portal's (which it doesn't have), not the check.
  expect((await visit("/help/.well-known/tuti-site")).headers.get("x-middleware-rewrite")).toContain(`/portal/${project.slug}/help/.well-known/tuti-site`);
  expect((await visit("/portal/.well-known/tuti-site")).headers.get("cache-control")).toBe("no-store");
  await call(setSite, as(), { url: "http://127.0.0.1:9/portal" });
  await expect(call(verifySite, as(), {})).rejects.toMatchObject({ status: 502, message: expect.stringContaining("We couldn't reach http://127.0.0.1:9/portal/.well-known/tuti-site") });
});

test("an address changed while it was checked isn't verified with the old one's check", async () => {
  await call(setSite, as(), { url: `${site.origin}/portal` });
  await forwardCheck();
  site.during(() => call(setSite, as(), { url: `${site.origin}/help` }));
  await expect(call(verifySite, as(), {})).rejects.toMatchObject({ status: 409 });
  expect((await call(getSite, as(), {})).site).toMatchObject({ url: `${site.origin}/help`, status: "pending" });
});

test("only an address with a path of its own, on a site of the team's own", async () => {
  for (const [url, message] of [
    ["not a url at all", "Enter your site's address with the path"],
    [site.origin, "Add the path the portal goes under"],
    [`${site.origin}/docs`, "The path can't start with /docs: it's one of the portal's own pages"],
    [`${site.origin}/help_center`, "The path can have lowercase letters, digits and dashes"],
    [`${site.origin}/portal?x=1`, "Enter just the address and path"],
    ["https://tuti.localhost/portal", "Pick a site of your own, not one under tuti.localhost"],
  ]) {
    await expect(call(setSite, as(), { url: url! })).rejects.toMatchObject({ status: 400, message: expect.stringContaining(message!) });
  }
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
  await expect(call(setSite, as(), { url: "http://acme.example/portal" })).rejects.toMatchObject({ message: "Your site's address must start with https://" });
  expect((await call(setSite, as(), { url: "acme.example/help/center" })).site.url).toBe("https://acme.example/help/center");
  await prisma.siteMount.deleteMany({ where: { projectId: project.id } });
});
