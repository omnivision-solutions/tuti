import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { auth } from "@/lib/auth";
import { appUrl } from "@/lib/hosts";
import { createApiKey } from "@/server/api-keys";
import { createConversation } from "@/server/operations/conversations";
import { call } from "@/server/operations/run";
import { renameProject } from "@/server/project-settings";
import { actAs, addMember, createProject, onPortal, signUp, type TestUser, withoutEmail } from "@/test/helpers";
import { request as browser } from "@/test/next-headers";

import { GET, PATCH, POST } from "./[...path]/route";
import { GET as listProjects } from "./projects/route";

/**
 * A teammate's app session on the REST API (server/api-auth.ts): its token in the Authorization header, the project in
 * Tuti-Project, and the operation run as them. Never the request's cookie.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  // Nobody is signed in on the "browser": only what a request sends counts.
  actAs(null);
  browser.written = [];
});

/** The session's token as its cookie has it (signed, percent-encoded): what signing in hands the app. */
const tokenOf = (user: TestUser) => /session_token=([^;]+)/.exec(user.cookie)![1]!;

type Sent = { token?: string | null; project?: string | null; cookie?: string; method?: "GET" | "PATCH" | "POST"; body?: unknown };

/** Calls the API as an app would: `token` as the bearer token, `project` in the Tuti-Project header. */
async function api(path: string, { token, project: slug = project.slug, cookie, method = "GET", body }: Sent) {
  const url = new URL(`${appUrl().origin}/api/v1${path}`);
  const request = new Request(url, {
    method,
    headers: {
      host: appUrl().host,
      ...(token && { authorization: `Bearer ${token}` }),
      ...(slug && { "tuti-project": slug }),
      ...(cookie && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response =
    path === "/projects"
      ? await listProjects(request)
      : await { GET, PATCH, POST }[method](request, { params: Promise.resolve({ path: url.pathname.split("/").slice(3) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const conversation = () => call(createConversation, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { email: "e2e-asker@example.com", body: "The export button does nothing" });

test("a teammate's session reads and answers their project's inbox, as themselves", async () => {
  const { number } = await conversation();
  const member = await addMember(project.id, "MEMBER");

  const listed = await api("/conversations", { token: tokenOf(member) });
  expect(listed).toMatchObject({ status: 200, body: { conversations: [{ number }] } });
  // No cookie comes back: the session is read, never extended, by the API.
  expect(listed.headers.get("set-cookie")).toBeNull();
  expect(browser.written).toEqual([]);

  // Decoded too: an app may keep the cookie's value either way.
  expect(await api(`/conversations/${number}`, { token: decodeURIComponent(tokenOf(member)) })).toMatchObject({ status: 200, body: { number } });

  // As the person, which a key isn't: marking read is theirs alone, and a reply is written by them.
  const seen = new Date().toISOString();
  expect(await api(`/conversations/${number}/read`, { token: tokenOf(member), method: "POST", body: { seen } })).toMatchObject({ status: 200 });
  expect(await prisma.conversationRead.count({ where: { userId: member.id } })).toBe(1);
  expect(await api(`/conversations/${number}/messages`, { token: tokenOf(member), method: "POST", body: { body: "Fixed in the next release" } })).toMatchObject({ status: 200 });
  expect(await prisma.conversationMessage.findFirstOrThrow({ where: { body: "Fixed in the next release" } })).toMatchObject({ authorId: member.id, author: "TEAM" });
});

test("a session works only in the projects its teammate is on, named on every request", async () => {
  await conversation();
  const outsider = await signUp("Otto Outsider");
  const theirs = await createProject(outsider);

  const refused = { status: 403, body: { error: { code: "forbidden", message: "You're not on the team of a project with that slug" } } };
  expect(await api("/conversations", { token: tokenOf(outsider) })).toEqual(expect.objectContaining(refused));
  // The same for a project that isn't there, so nothing tells which slugs are taken.
  expect(await api("/conversations", { token: tokenOf(outsider), project: "no-such-project" })).toEqual(expect.objectContaining(refused));
  // Their own works, and shows none of the other's.
  expect(await api("/conversations", { token: tokenOf(outsider), project: theirs.slug })).toMatchObject({ status: 200, body: { conversations: [] } });

  expect(await api("/conversations", { token: tokenOf(owner), project: null })).toMatchObject({
    status: 400,
    body: { error: { code: "project_required", message: "Say which project: send its slug in the Tuti-Project header. GET /api/v1/projects lists yours." } },
  });

  // Checked on each request: off the team, the same session stops working there.
  const member = await addMember(project.id, "MEMBER");
  expect(await api("/conversations", { token: tokenOf(member) })).toMatchObject({ status: 200 });
  await prisma.teamMember.delete({ where: { id: member.memberId } });
  expect(await api("/conversations", { token: tokenOf(member) })).toEqual(expect.objectContaining(refused));
});

test("a session that expired, was signed out, or isn't the app's is refused", async () => {
  const unauthorized = { status: 401, body: { error: { code: "unauthorized", message: "This session isn't valid or has ended: sign in again. (A project API key starts tuti_.)" } } };
  const token = tokenOf(owner);
  expect(await api("/conversations", { token })).toMatchObject({ status: 200 });

  // A token nobody signed, the stored token without its signature, and a signature that isn't the server's.
  const [stored, signature] = decodeURIComponent(token).split(".") as [string, string];
  for (const forged of ["nonsense", stored, `${stored}.${signature.replace(/^./, (c) => (c === "A" ? "B" : "A"))}`]) {
    expect(await api("/conversations", { token: forged })).toEqual(expect.objectContaining(unauthorized));
  }

  await prisma.session.updateMany({ where: { userId: owner.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await api("/conversations", { token })).toEqual(expect.objectContaining(unauthorized));

  const again = await signUp("Olive again");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: again.id, role: "ADMIN" } });
  expect(await api("/conversations", { token: tokenOf(again) })).toMatchObject({ status: 200 });
  await auth.api.signOut({ headers: new Headers({ host: appUrl().host, cookie: again.cookie }) });
  expect(await api("/conversations", { token: tokenOf(again) })).toEqual(expect.objectContaining(unauthorized));

  // A portal's session is a reader's, even a teammate's on their own project's portal.
  const reader = await addMember(project.id, "ADMIN");
  await onPortal(reader, project);
  expect(await api("/conversations", { token: tokenOf(reader) })).toEqual(expect.objectContaining(unauthorized));
});

test("an address that isn't verified has no session on a server that sends email, as on the web", async () => {
  const unverified = await signUp("Una Unverified", undefined, { verified: false });
  await prisma.teamMember.create({ data: { projectId: project.id, userId: unverified.id, role: "MEMBER" } });
  expect(await api("/conversations", { token: tokenOf(unverified) })).toMatchObject({ status: 401 });
  expect(await withoutEmail(() => api("/conversations", { token: tokenOf(unverified) }))).toMatchObject({ status: 200 });
});

test("a cookie is never a session here: a page in a browser can't use its visitor's", async () => {
  await conversation();
  // The request's own cookie, and the browser's as server actions read it.
  actAs(owner);
  expect(await api("/conversations", { cookie: owner.cookie })).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
  expect(await api("/projects", { cookie: owner.cookie })).toMatchObject({ status: 401 });
  expect(await api("/project", { cookie: owner.cookie, method: "PATCH", body: { name: "Renamed by a page" } })).toMatchObject({ status: 401 });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe(project.name);

  // With someone else's cookie beside it, the token alone says who: the outsider's cookie adds nothing.
  const outsider = await signUp("Otto Outsider");
  expect(await api("/conversations", { token: tokenOf(outsider), cookie: owner.cookie })).toMatchObject({ status: 403 });
});

test("a key works as before: it decides the project, whatever the header says", async () => {
  const other = await createProject(owner);
  actAs(owner);
  const key = (await createApiKey(project.slug, "Tests", "READ")).key!;
  actAs(null);
  expect(await api("/project", { token: key, project: other.slug })).toMatchObject({ status: 200, body: { slug: project.slug } });
  expect(await api("/project", { token: key, project: null })).toMatchObject({ status: 200, body: { slug: project.slug } });
  // Read only, and never a person: both as without sessions.
  expect(await api("/project", { token: key, method: "PATCH", body: { name: "Renamed" } })).toMatchObject({ status: 403, body: { error: { message: "This key can only read. Create a read + write key to change things." } } });
  expect(await api("/conversations/1/read", { token: key, method: "POST", body: { seen: null } })).toMatchObject({ status: 403 });
  expect(await api("/conversations", { token: `tuti_${"x".repeat(43)}` })).toMatchObject({ status: 401, body: { error: { message: "This API key isn't valid or was revoked" } } });
  expect(await api("/conversations", {})).toMatchObject({ status: 401, body: { error: { message: "Send a project API key: Authorization: Bearer tuti_…" } } });
});

test("a session acts with its teammate's role, refused where the web app's action refuses them", async () => {
  const member = await addMember(project.id, "MEMBER");
  const admin = await addMember(project.id, "ADMIN");
  const rename = (name: string) => {
    const form = new FormData();
    form.set("name", name);
    return renameProject(project.slug, {}, form);
  };

  // A member: the settings are owners' and admins', in the app and here.
  actAs(member);
  expect(await rename("Member's name")).toEqual({ error: "Only project owners and admins can rename the project" });
  actAs(null);
  expect(await api("/project", { token: tokenOf(member), method: "PATCH", body: { name: "Member's name" } })).toMatchObject({
    status: 403,
    body: { error: { code: "forbidden", message: "Only project owners and admins can use project settings" } },
  });
  // What only owners change (how Autopilot is tuned) is refused an admin.
  expect(await api("/code-changes-tuning", { token: tokenOf(admin), method: "PATCH", body: {} })).toMatchObject({ status: 403, body: { error: { message: "Only project owners can change this" } } });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe(project.name);

  expect(await api("/project", { token: tokenOf(admin), method: "PATCH", body: { name: "Admin's name" } })).toMatchObject({ status: 200, body: { name: "Admin's name" } });
});

test("the projects list is the teammate's own, with their role in each", async () => {
  const member = await addMember(project.id, "MEMBER");
  const second = await prisma.project.create({ data: { slug: `${project.slug}-b`, name: "Second", team: { create: { userId: member.id, role: "OWNER" } } } });
  await createProject(await signUp("Otto Outsider"));
  await conversation();

  const listed = await api("/projects", { token: tokenOf(member), project: null });
  expect(listed).toEqual(
    expect.objectContaining({
      status: 200,
      body: {
        projects: [
          { slug: project.slug, name: project.name, role: "MEMBER", openConversations: 1 },
          { slug: second.slug, name: "Second", role: "OWNER", openConversations: 0 },
        ],
      },
    }),
  );
  expect(await api("/projects", { token: tokenOf(await signUp("Nora New")), project: null })).toMatchObject({ status: 200, body: { projects: [] } });

  actAs(owner);
  const key = (await createApiKey(project.slug, "Tests", "READ")).key!;
  actAs(null);
  expect(await api("/projects", { token: key })).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
  expect(await api("/projects", { token: "nonsense" })).toMatchObject({ status: 401 });
});

test("requests are limited per teammate, over their projects and sessions", async () => {
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  expect(await api("/conversations", { token: tokenOf(owner) })).toMatchObject({ status: 200 });
  expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ apiRateCount: 1, apiRateWindowStart: window });

  await prisma.user.update({ where: { id: owner.id }, data: { apiRateCount: 600, apiRateWindowStart: window } });
  const limited = await api("/conversations", { token: tokenOf(owner) });
  expect(limited).toMatchObject({ status: 429, body: { error: { code: "rate_limited", message: "Up to 600 requests a minute per teammate" } } });
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await api("/projects", { token: tokenOf(owner) })).toMatchObject({ status: 429 });

  // The next minute starts a new count; someone else's is their own.
  await prisma.user.update({ where: { id: owner.id }, data: { apiRateWindowStart: new Date(window.getTime() - 60_000) } });
  expect(await api("/conversations", { token: tokenOf(owner) })).toMatchObject({ status: 200 });
  expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).apiRateCount).toBe(1);
});

test("the API never extends a session: the app's own session read does", async () => {
  // A day from expiring: any read through Better Auth with refresh on would push it out again.
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.session.updateMany({ where: { userId: owner.id }, data: { expiresAt } });
  expect(await api("/conversations", { token: tokenOf(owner) })).toMatchObject({ status: 200 });
  expect((await prisma.session.findFirstOrThrow({ where: { userId: owner.id } })).expiresAt).toEqual(expiresAt);
  // And hands out no cookie: an ended session's answer can only clear them.
  await prisma.session.updateMany({ where: { userId: owner.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await api("/conversations", { token: tokenOf(owner) })).toMatchObject({ status: 401 });
  expect(browser.written.filter((cookie) => cookie.value !== "")).toEqual([]);
});
