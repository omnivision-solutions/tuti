import { prisma } from "@tuti/db";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";

import { GET as trpcGet, POST as trpcPost } from "@/app/api/trpc/[trpc]/route";
import { proxy } from "@/proxy";
import { PREVIEW_READER_COOKIE, WIDGET_READER_COOKIE } from "@/server/auth/portal-readers";
import { previewToken } from "@/server/auth/preview-session";
import { newVisitor } from "@/server/auth/visitor-session";
import { widgetToken } from "@/server/auth/widget-session";
import { serverCaller } from "@/server/trpc/server";
import { callerAs, createProject, onPortal, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { forgetCustomDomain } from "../custom-domains";

/**
 * Readers and visitors on the router (docs/plan.md, "One way in", T8): a portal's reader by their session, Customize's
 * preview cookie and the widget's reader cookie (who may read, never who acts), and the widget's person by
 * `Authorization: Widget …` or `Visitor …`. proxy.ts's gate and the router decide who may read with one function.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  forgetCustomDomain("");
});

const host = () => `${project.slug}.localhost:3100`;

/** A procedure through /api/trpc, as the portal's pages and the widget call it: its status and body. */
async function trpc(name: string, input: object, headers: Record<string, string> = {}, mutation = false) {
  const json = encodeURIComponent(JSON.stringify({ json: { project: project.slug, ...input } }));
  const response = mutation
    ? await trpcPost(
        new Request(`http://${host()}/api/trpc/${name}`, {
          method: "POST",
          headers: { host: host(), "content-type": "application/json", ...headers },
          body: JSON.stringify({ json: { project: project.slug, ...input } }),
        }),
      )
    : await trpcGet(new Request(`http://${host()}/api/trpc/${name}?input=${json}`, { headers: { host: host(), ...headers } }));
  return { status: response.status, body: (await response.json()) as unknown };
}

const post = async () => (await (await callerAs(owner)).posts.create({ project: project.slug, board: "feature-requests", title: "Dark mode" })).number;

test("a portal under a path of the team's site saves through <base>/api/trpc, which passes the same-site check", async () => {
  await prisma.siteMount.create({ data: { projectId: project.id, origin: "https://acme.example", path: "/portal", verificationToken: "t", verifiedAt: new Date() } });
  const reader = await signUp("Rae Reader");
  await onPortal(reader, project);
  const number = await post();

  // The site's page posts to <base>/api/trpc, its own origin: proxy.ts sends it on to /api/trpc, told the site's host.
  const sent = { host: host(), cookie: reader.cookie, origin: "https://acme.example" };
  const forwarded = await proxy(new NextRequest(`http://${host()}/portal/api/trpc/votes.set`, { method: "POST", headers: { ...sent, "sec-fetch-site": "same-origin" } }));
  expect(forwarded.headers.get("x-middleware-rewrite")).toBe(`http://${host()}/api/trpc/votes.set`);
  const siteHost = forwarded.headers.get("x-middleware-request-x-forwarded-host");
  expect(siteHost).toBe("acme.example");

  // As forwarded: the browser's Sec-Fetch-Site, or, from one that doesn't send it, its Origin on the site's host.
  expect((await trpc("votes.set", { number, voted: true }, { cookie: reader.cookie, origin: sent.origin, "x-forwarded-host": siteHost!, "sec-fetch-site": "same-origin" }, true)).status).toBe(200);
  expect((await trpc("votes.set", { number, voted: false }, { cookie: reader.cookie, origin: sent.origin, "x-forwarded-host": siteHost! }, true)).status).toBe(200);
  // Another site's page is refused, and nothing changes.
  const other = await trpc("votes.set", { number, voted: true }, { cookie: reader.cookie, origin: "https://evil.example", "x-forwarded-host": siteHost! }, true);
  expect(other.status).toBe(403);
  expect(await prisma.vote.count({ where: { userId: reader.id } })).toBe(0);
});

test("for the same session and preview cookie, a private portal's page through the proxy and a /api/trpc read give the same answer", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  const reader = await signUp("Rae Reader");
  await prisma.portalReader.create({ data: { projectId: project.id, email: reader.email } });
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  const outsider = await signUp("Otto Outsider");
  await onPortal(reader, project);
  await onPortal(outsider, project);
  const preview = `${PREVIEW_READER_COOKIE}=${encodeURIComponent(previewToken(project.id, owner.id))}`;

  /** proxy.ts's answer for the portal's home page, and the router's for portal.access, with the same cookies. */
  const answers = async (cookie?: string) => {
    const page = await proxy(new NextRequest(`http://${host()}/`, { headers: { host: host(), ...(cookie && { cookie }) } }));
    const read = await trpc("portal.access", {}, cookie ? { cookie } : {});
    return { proxy: page.headers.has("x-middleware-rewrite") && !page.headers.has("location"), trpc: read.status === 200 };
  };
  expect(await answers()).toEqual({ proxy: false, trpc: false });
  expect(await answers(outsider.cookie)).toEqual({ proxy: false, trpc: false });
  expect(await answers(reader.cookie)).toEqual({ proxy: true, trpc: true });
  expect(await answers(preview)).toEqual({ proxy: true, trpc: true });
  expect(await answers(`${outsider.cookie}; ${preview}`)).toEqual({ proxy: true, trpc: true });
  // The widget's reader cookie (sent only inside its frame on the customer's site): its person, a reader or not.
  const widgetReader = (user: TestUser) => `${WIDGET_READER_COOKIE}=${encodeURIComponent(widgetToken(project.id, user.id))}`;
  expect(await answers(widgetReader(reader))).toEqual({ proxy: true, trpc: true });
  expect(await answers(widgetReader(outsider))).toEqual({ proxy: false, trpc: false });
  // A preview of someone no longer on the team reads nothing.
  await prisma.teamMember.deleteMany({ where: { projectId: project.id, userId: owner.id } });
  expect(await answers(preview)).toEqual({ proxy: false, trpc: false });
});

test("the widget's person: someone the site signed in acts as themselves; a visitor and a preview only read", async () => {
  const number = await post();
  const person = await signUp("Wes Widget");
  const widget = { authorization: `Widget ${widgetToken(project.id, person.id)}` };
  const visitor = { authorization: `Visitor ${newVisitor(project.id).token}` };
  // From the portal's own page: a cookie's mutation from another site is refused before anything else (the same-site check).
  const preview = { cookie: `${PREVIEW_READER_COOKIE}=${encodeURIComponent(previewToken(project.id, owner.id))}`, "sec-fetch-site": "same-origin" };

  // Signed in by the customer's site: they vote as themselves.
  expect((await trpc("votes.set", { number, voted: true }, widget, true)).status).toBe(200);
  expect(await prisma.vote.count({ where: { userId: person.id } })).toBe(1);
  // A token for another project, or none of ours, isn't anyone.
  const elsewhere = await createProject(owner);
  expect((await trpc("votes.set", { number, voted: true }, { authorization: `Widget ${widgetToken(elsewhere.id, person.id)}` }, true)).status).toBe(401);

  expect(await prisma.vote.count({ where: { post: { projectId: project.id } } })).toBe(2);
  // A signed-out visitor, nobody, and the team's preview (never the team member acting) may read, and act nowhere else.
  for (const headers of [visitor, {}, preview]) {
    expect((await trpc("portal.access", {}, headers)).status).toBe(200);
    expect((await trpc("votes.set", { number, voted: true }, headers, true)).status).toBe(401);
  }
  // Only the author's and the widget's person's votes.
  expect(await prisma.vote.count({ where: { post: { projectId: project.id } } })).toBe(2);
});

test("the widget's person acts as themselves, never as the team: a teammate by the widget's token can't run the team's procedures", async () => {
  const teammate = { authorization: `Widget ${widgetToken(project.id, owner.id)}` };
  // The owner, by the widget: their team's settings and Inbox stay closed (a portal's or the widget's session is a reader's).
  expect((await trpc("settings.access", {}, teammate)).status).toBe(403);
  expect((await trpc("project.get", {}, teammate)).status).toBe(403);
  // What anyone signed in may do, they do as themselves.
  expect((await trpc("portal.access", {}, teammate)).status).toBe(200);
});

test("a proxy's Authorization on the portal's requests is never the widget's person: the cookie session still is", async () => {
  const number = await post();
  const reader = await signUp("Rae Reader");
  await onPortal(reader, project);
  for (const authorization of ["Basic cmFlOnBhc3N3b3Jk", "Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl"]) {
    expect((await trpc("votes.set", { number, voted: true }, { cookie: reader.cookie, authorization, "sec-fetch-site": "same-origin" }, true)).status).toBe(200);
  }
  expect(await prisma.vote.count({ where: { userId: reader.id } })).toBe(1);
});

test("the widget's person reads a private portal they're a reader of, by its token or its reader cookie; others don't", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  const reader = await signUp("Rae Reader");
  await prisma.portalReader.create({ data: { projectId: project.id, email: reader.email } });
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  const stranger = await signUp("Sam Stranger");
  const token = (user: TestUser) => encodeURIComponent(widgetToken(project.id, user.id));
  expect((await trpc("portal.access", {}, { authorization: `Widget ${widgetToken(project.id, reader.id)}` })).status).toBe(200);
  expect((await trpc("portal.access", {}, { cookie: `${WIDGET_READER_COOKIE}=${token(reader)}` })).status).toBe(200);
  expect((await trpc("portal.access", {}, { authorization: `Widget ${widgetToken(project.id, stranger.id)}` })).status).toBe(403);
  expect((await trpc("portal.access", {}, { cookie: `${WIDGET_READER_COOKIE}=${token(stranger)}` })).status).toBe(403);
  // The team, by the widget, as without it (read with no portal session: their membership counts).
  expect((await trpc("portal.access", {}, { authorization: `Widget ${widgetToken(project.id, owner.id)}` })).status).toBe(200);
});

test("a mutation from another site carrying only a reader's cookie is refused as a session's is", async () => {
  const number = await post();
  for (const cookie of [`${PREVIEW_READER_COOKIE}=${encodeURIComponent(previewToken(project.id, owner.id))}`, `${WIDGET_READER_COOKIE}=${encodeURIComponent(widgetToken(project.id, owner.id))}`]) {
    const refused = await trpc("votes.set", { number, voted: true }, { cookie, origin: "https://evil.example" }, true);
    // The same-site check's refusal (without it: "Sign in to do this", a 401).
    expect({ status: refused.status, said: JSON.stringify(refused.body).includes("didn't come from this site's own page") }).toEqual({ status: 403, said: true });
  }
});

test("a page reads as the request's reader: Customize's preview reads a private portal, as proxy.ts lets its page through", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  request.host = host();
  request.cookie = `${PREVIEW_READER_COOKIE}=${encodeURIComponent(previewToken(project.id, owner.id))}`;
  try {
    await expect((await serverCaller()).portal.access({ project: project.slug })).resolves.toEqual({});
  } finally {
    request.cookie = "";
    request.host = "";
  }
});
