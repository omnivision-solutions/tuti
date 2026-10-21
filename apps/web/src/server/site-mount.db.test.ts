import { prisma } from "@tuti/db";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test } from "vitest";

import PostPage from "@/app/portal/[project]/(site)/feedback/[board]/[post]/page";
import PortalHome from "@/app/portal/[project]/(site)/page";
import { SignJWT } from "jose";

import { GET as authGet, POST as authRoute } from "@/app/api/auth/[...all]/route";
import { GET as ssoRoute } from "@/app/portal/[project]/(site)/sso/route";
import { auth } from "@/lib/auth";
import { BASE_HEADER } from "@/lib/portal-base";
import { generateSsoSecret } from "@/lib/sso";
import { proxy } from "@/proxy";
import { createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { forgetCustomDomain } from "./custom-domains";
import { updatePortal } from "./operations/portal";
import { call } from "./operations/run";

/**
 * A portal under a path of the team's own site (acme.example/portal): the site forwards that path
 * to the portal's Tuti address, path and all; the portal answers there and adds the path to its links.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  await prisma.siteMount.create({ data: { projectId: project.id, origin: "https://acme.example", path: "/portal", verificationToken: "t", verifiedAt: new Date() } });
  forgetCustomDomain("");
});
afterEach(() => {
  request.headers = {};
});

const host = () => `${project.slug}.localhost:3100`;
const visit = (path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`http://${host()}${path}`, { headers: { host: host(), ...headers } }));
/** The request headers proxy.ts passes on to the page (Next.js's override headers). */
const passedOn = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`);

test("under the path: the portal's own page, told the path; elsewhere: the portal as usual, told none", async () => {
  const mounted = await visit("/portal/feedback/feature-requests?x=1");
  expect(mounted.headers.get("x-middleware-rewrite")).toBe(`http://${host()}/portal/${project.slug}/feedback/feature-requests?x=1`);
  expect(passedOn(mounted, BASE_HEADER)).toBe("/portal");
  expect((await visit("/portal")).headers.get("x-middleware-rewrite")).toBe(`http://${host()}/portal/${project.slug}`);

  // The portal at its own address: no path, whatever the request says (the widget's panel, which stays there).
  const direct = await visit("/widget", { [BASE_HEADER]: "/evil" });
  expect(direct.headers.get("x-middleware-rewrite")).toBe(`http://${host()}/portal/${project.slug}/widget`);
  expect(passedOn(direct, BASE_HEADER)).toBe("");
  // Other pages at its Tuti address go to the site; /portalx isn't under the path.
  expect((await visit("/portalx/docs")).headers.get("location")).toBe("https://acme.example/portal/portalx/docs");
});

test("not until it's verified", async () => {
  await prisma.siteMount.updateMany({ where: { projectId: project.id }, data: { verifiedAt: null } });
  forgetCustomDomain("");
  const response = await visit("/portal/feedback/feature-requests");
  expect(passedOn(response, BASE_HEADER)).toBe("");
});

test("a private one sends people to its sign-in on the site, under the path", async () => {
  await call(updatePortal, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { access: "private" });
  const response = await visit("/portal/roadmap");
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("https://acme.example/portal/sign-in?next=%2Froadmap");
});

test("its pages' redirects stay under the path", async () => {
  request.headers = { [BASE_HEADER]: "/portal" };
  expect(await redirectTarget(PortalHome({ params: Promise.resolve({ project: project.slug }) } as never))).toBe("/portal/feedback/feature-requests");
  const number = (await prisma.project.update({ where: { id: project.id }, data: { postCount: { increment: 1 } } })).postCount;
  await prisma.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number, title: "Dark mode", body: "" } });
  const open = PostPage({ params: Promise.resolve({ project: project.slug, board: "x", post: String(number) }), searchParams: Promise.resolve({}) } as never);
  expect(await redirectTarget(open)).toBe(`/portal/feedback/feature-requests/dark-mode-${number}`);
  // A path a request makes up isn't used.
  request.headers = { [BASE_HEADER]: "//evil.example" };
  expect(await redirectTarget(PortalHome({ params: Promise.resolve({ project: project.slug }) } as never))).toBe("/feedback/feature-requests");
});

test("signing in on the site: the auth API and Tuti's icon under the path, told the site's host", async () => {
  const api = await visit("/portal/api/auth/get-session");
  expect(api.headers.get("x-middleware-rewrite")).toBe(`http://${host()}/api/auth/get-session`);
  expect(passedOn(api, BASE_HEADER)).toBe("/portal");
  // As if the site's proxy said so: forms posted from the site's pages count as posted to it.
  expect(passedOn(api, "x-forwarded-host")).toBe("acme.example");
  expect(passedOn(api, "x-forwarded-proto")).toBe("https");
  expect(passedOn(await visit("/portal/docs", { "x-forwarded-host": "evil.example" }), "x-forwarded-host")).toBe("acme.example");
  expect((await visit("/portal/icon.svg")).headers.get("x-middleware-rewrite")).toBe(`http://${host()}/icon.svg`);
});

test("the site's pages may post to its sign-in: Better Auth trusts the site once it's verified", async () => {
  const trusted = (auth.options.trustedOrigins as (request?: Request) => Promise<string[]>)(new Request(`http://${host()}/api/auth/sign-in/email`, { headers: { host: host() } }));
  expect(await trusted).toContain("https://acme.example");
  await prisma.siteMount.updateMany({ where: { projectId: project.id }, data: { verifiedAt: null } });
  forgetCustomDomain("");
  expect(await (auth.options.trustedOrigins as (request?: Request) => Promise<string[]>)(new Request(`http://${host()}/x`, { headers: { host: host() } }))).not.toContain("https://acme.example");
});

test("SSO there comes back under the path, errors too", async () => {
  const secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: "user-1", jti: crypto.randomUUID(), name: "Sam" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(secret));
  const sso = (query: string) =>
    ssoRoute(new Request(`http://${host()}/portal/sso?${query}`, { headers: { host: host(), [BASE_HEADER]: "/portal" } }));
  expect((await sso(`token=${token}&redirect=%2Froadmap`)).headers.get("location")).toBe("/portal/roadmap");
  expect((await sso("token=not-a-token")).headers.get("location")).toMatch(/^\/portal\/sso\/error\?code=/);
});

test("session cookies are Tuti's own (tuti.…), beside a site's", async () => {
  const response = await authRoute(
    new Request(`http://${host()}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { host: host(), "content-type": "application/json" },
      body: JSON.stringify({ email: `e2e-${crypto.randomUUID()}@example.com`, password: "correct horse battery staple", name: "Ada" }),
    }),
  );
  expect(response.headers.getSetCookie().join("\n")).toMatch(/(^|\n)tuti\.session_token=/);
});

test("\"Continue with your Tuti account\" there comes back under the path, a failed one too", async () => {
  const response = await authGet(
    new Request(`http://${host()}/portal/api/auth/continue/callback?code=not-a-code&redirect=%2Froadmap`, { headers: { host: host(), [BASE_HEADER]: "/portal" } }),
  );
  expect(response.headers.get("location")).toBe("/portal/sign-in?continue=failed");
});
