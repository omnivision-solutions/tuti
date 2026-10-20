import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { SignJWT } from "jose";
import { beforeEach, expect, test } from "vitest";

import { GET, OPTIONS, POST } from "@/app/api/widget/seen/route";
import { generateSsoSecret } from "@/lib/sso";
import { actAs, createProject, signUp } from "@/test/helpers";

import { markChangelogSeen } from "./changelog-seen";
import { hasUnseenAnnouncement } from "./operations/changelog-seen";

let project: Awaited<ReturnType<typeof createProject>>;
let secret: string;

beforeEach(async () => {
  project = await createProject(await signUp());
  secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
});

/** A sign-in token from the project's own app; `ago` seconds old, valid for 5 minutes from then. */
function ssoToken(sub: string, { key = secret, ago = 0 } = {}) {
  const issued = Math.floor(Date.now() / 1000) - ago;
  return new SignJWT({ sub, jti: randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issued)
    .setExpirationTime(issued + 300)
    .sign(new TextEncoder().encode(key));
}

/** The widget script asking what `token`'s person has seen (GET), or saying they've seen up to `at` (POST). */
async function ask(token: string | null, { at, slug = project.slug }: { at?: string; slug?: string } = {}) {
  const init = {
    method: at === undefined ? "GET" : "POST",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: at === undefined ? undefined : JSON.stringify({ at }),
  };
  const request = new Request(`http://tuti.localhost:3100/api/widget/seen?project=${slug}`, init);
  const response = await (at === undefined ? GET : POST)(request);
  return { status: response.status, headers: response.headers, body: (await response.json()) as { seen?: string | null; error?: string } };
}

const rows = () => prisma.changelogSeen.findMany({ orderBy: [{ projectId: "asc" }, { userId: "asc" }] });

test("someone the page signs in: what they've seen is kept and read back, from any device, and never moves back", async () => {
  expect((await ask(await ssoToken("app-user-1"))).body).toEqual({ seen: null });

  const response = await ask(await ssoToken("app-user-1"), { at: "2026-10-18T10:00:00.000Z" });
  expect(response.body).toEqual({ seen: "2026-10-18T10:00:00.000Z" });
  // Any site may call it, and the answer is this person's: never cached.
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(OPTIONS().headers.get("access-control-allow-headers")).toContain("authorization");

  // An older time (a device that showed an older list) doesn't move it back.
  expect((await ask(await ssoToken("app-user-1"), { at: "2026-10-01T00:00:00.000Z" })).body).toEqual({ seen: "2026-10-18T10:00:00.000Z" });
  expect((await ask(await ssoToken("app-user-1"))).body).toEqual({ seen: "2026-10-18T10:00:00.000Z" });
  // Nor does one from the future go past now.
  const future = await ask(await ssoToken("app-user-1"), { at: "2099-01-01T00:00:00.000Z" });
  expect(new Date(future.body.seen!).getTime()).toBeLessThanOrEqual(Date.now());
  expect(new Date(future.body.seen!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  // Two devices at once end on the later time.
  await Promise.all([
    ask(await ssoToken("app-user-2"), { at: "2026-10-18T10:00:00.000Z" }),
    ask(await ssoToken("app-user-2"), { at: "2026-10-19T10:00:00.000Z" }),
  ]);
  expect((await ask(await ssoToken("app-user-2"))).body).toEqual({ seen: "2026-10-19T10:00:00.000Z" });
});

test("each person and project has their own; nobody else's changes", async () => {
  await ask(await ssoToken("app-user-1"), { at: "2026-10-18T10:00:00.000Z" });
  expect((await ask(await ssoToken("app-user-2"))).body).toEqual({ seen: null });

  // The same person's id in another project's app is someone else.
  const other = await createProject(await signUp());
  const otherSecret = generateSsoSecret();
  await prisma.project.update({ where: { id: other.id }, data: { ssoSecret: otherSecret } });
  expect((await ask(await ssoToken("app-user-1", { key: otherSecret }), { slug: other.slug })).body).toEqual({ seen: null });
  await ask(await ssoToken("app-user-1", { key: otherSecret }), { at: "2026-10-19T10:00:00.000Z", slug: other.slug });
  expect((await ask(await ssoToken("app-user-1"))).body).toEqual({ seen: "2026-10-18T10:00:00.000Z" });
  expect(await prisma.changelogSeen.count({ where: { projectId: { in: [project.id, other.id] } } })).toBe(2);
});

test("expired, forged, reused or missing tokens are refused and change nothing", async () => {
  await ask(await ssoToken("app-user-1"), { at: "2026-10-18T10:00:00.000Z" });
  const before = await rows();

  const used = await ssoToken("app-user-1");
  await ask(used);
  const refused = [
    await ssoToken("app-user-1", { ago: 600 }), // expired 5 minutes ago
    await ssoToken("app-user-1", { key: generateSsoSecret() }), // not signed with this project's secret
    used, // tokens work once
    "not-a-jwt",
    null, // anonymous visitors
  ];
  for (const token of refused) {
    for (const at of [undefined, "2026-10-20T00:00:00.000Z"]) {
      const response = await ask(token, { at });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: expect.any(String) });
    }
  }
  // Without SSO set up, or for no such project, nobody is signed in.
  const unset = await createProject(await signUp());
  expect((await ask(await ssoToken("app-user-1"), { slug: unset.slug })).status).toBe(401);
  expect((await ask(await ssoToken("app-user-1"), { slug: "no-such-project" })).status).toBe(401);
  expect(await rows()).toEqual(before);
});

test("on the portal, a signed-in user who views the changelog has seen it: the nav's marker goes, on every device", async () => {
  const ada = await signUp("Ada");
  const announce = (daysAgo: number, number: number, announced = true) =>
    prisma.changelogEntry.create({
      data: { projectId: project.id, number, title: `Entry ${number}`, announced, publishedAt: new Date(Date.now() - daysAgo * 86_400_000) },
    });
  // Nothing announced, or only a long time ago, or quietly: nothing new.
  expect(await hasUnseenAnnouncement(project.id, ada.id)).toBe(false);
  await announce(40, 1);
  await announce(1, 2, false);
  expect(await hasUnseenAnnouncement(project.id, ada.id)).toBe(false);

  const entry = await announce(5, 3);
  expect(await hasUnseenAnnouncement(project.id, ada.id)).toBe(true);
  actAs(ada);
  expect(await markChangelogSeen(project.slug, entry.publishedAt!.toISOString())).toEqual({});
  expect(await hasUnseenAnnouncement(project.id, ada.id)).toBe(false);
  // A newer announcement is new again.
  await announce(0, 4);
  expect(await hasUnseenAnnouncement(project.id, ada.id)).toBe(true);

  // Signed out, nothing is kept.
  actAs(null);
  expect(await markChangelogSeen(project.slug, new Date().toISOString())).toEqual({ error: "Sign in first" });
  expect(await prisma.changelogSeen.count({ where: { projectId: project.id } })).toBe(1);
});
