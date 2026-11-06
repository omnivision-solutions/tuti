import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { GET as startContinue } from "@/app/portal/[project]/(site)/continue/route";
import { forgetCustomDomain } from "@/server/custom-domains";
import { getOwnerProject } from "@/server/membership";
import { portalPreview } from "@/server/customize";
import { setAutopilotEmails } from "@/server/github";
import { setAvatar } from "@/server/media";
import { askAPerson } from "@/server/operations/docs-escalate";
import { call } from "@/server/operations/run";
import { getChangelogEntry } from "@/server/operations/changelog";
import { createComment as createCommentOperation } from "@/server/operations/create";
import { listComments } from "@/server/operations/read";
import { currentPostViewer, mayRead, portalVisitor, readerOf } from "@/server/portal-access";
import { addComment, createPost } from "@/server/posts";
import { findSimilarPosts } from "@/server/similar-posts";
import { widgetIdeas } from "@/server/widget";
import { answerArticle } from "@/server/docs-readers";
import { portalReaderHome } from "@/server/widget-home";
import { widgetPerson } from "@/server/widget-person";
import { continueToPortal } from "@/server/portal-handoff";
import { getAccountSession, getSession } from "@/server/session";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { auth } from "./auth";
import { HANDOFF_STATE_COOKIE, randomSecret } from "./portal-handoff";

let ada: TestUser;
let slug: string;

beforeEach(async () => {
  ada = await signUp("Ada");
  slug = (await createProject(await signUp("Owner"))).slug;
  actAs(ada);
  request.host = "";
});

const APP_HOST = "tuti.localhost:3100";
const portalHost = (projectSlug = slug) => `${projectSlug}.localhost:3100`;

/** Ada confirms "Continue as Ada" on the app host; returns the portal callback URL. */
async function confirm(state: string, redirectPath = "/") {
  return new URL(await redirectTarget(continueToPortal(slug, state, redirectPath)));
}

/** The browser opens the callback on `host`, sending `state` in the portal's cookie. */
async function callback(url: URL, state: string | null, host = portalHost()) {
  const headers = new Headers({ host });
  if (state) {
    headers.set("cookie", `${HANDOFF_STATE_COOKIE}=${state}`);
  }
  const response = await auth.handler(new Request(`http://${host}${url.pathname}${url.search}`, { headers }));
  const cookie = response.headers
    .getSetCookie()
    .filter((c) => !c.startsWith(`${HANDOFF_STATE_COOKIE}=`))
    .map((c) => c.split(";")[0])
    .join("; ");
  const session = cookie ? await auth.api.getSession({ headers: new Headers({ cookie, host }) }) : null;
  return { location: response.headers.get("location"), userId: session?.user.id ?? null };
}

test("the portal sets a state cookie and sends the browser to the app host with it", async () => {
  const response = await startContinue(new Request(`http://${portalHost()}/continue?redirect=/feedback/ideas`), {
    params: Promise.resolve({ project: slug }),
  });
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("http://tuti.localhost:3100/continue");
  expect(location.searchParams.get("portal")).toBe(slug);
  expect(location.searchParams.get("redirect")).toBe("/feedback/ideas");
  const state = location.searchParams.get("state");
  expect(response.headers.getSetCookie()).toEqual([
    expect.stringMatching(new RegExp(`^${HANDOFF_STATE_COOKIE}=${state}; .*HttpOnly.*SameSite=lax`, "i")),
  ]);
});

test("confirming signs the same account into the portal, once", async () => {
  const state = randomSecret();
  const url = await confirm(state, "/feedback/ideas");
  expect(url.origin).toBe(`http://${portalHost()}`);

  expect(await callback(url, state)).toEqual({ location: "/feedback/ideas", userId: ada.id });
  // The code is gone after its first use.
  expect(await callback(url, state)).toEqual({ location: "/sign-in?continue=failed", userId: null });
});

test("a code only works in the browser that asked for it", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  // Someone sends their own code to another browser (login CSRF): no state cookie, or a different one.
  expect(await callback(url, null)).toEqual({ location: "/sign-in?continue=failed", userId: null });
  expect(await callback(url, randomSecret())).toEqual({ location: "/sign-in?continue=failed", userId: null });
  // A failed try uses the code up.
  expect(await callback(url, state)).toEqual({ location: "/sign-in?continue=failed", userId: null });
});

test("a code only works on the portal it was issued for", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  const other = await createProject(ada);
  expect(await callback(url, state, portalHost(other.slug))).toEqual({
    location: "/sign-in?continue=failed",
    userId: null,
  });
});

test("an expired code doesn't work", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  await prisma.portalHandoff.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await callback(url, state)).toEqual({ location: "/sign-in?continue=failed", userId: null });
});

test("only same-site paths are followed after signing in", async () => {
  const state = randomSecret();
  const url = await confirm(state, "//evil.example/");
  expect(await callback(url, state)).toEqual({ location: "/", userId: ada.id });
});

test("only hashes are stored", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  const handoff = await prisma.portalHandoff.findFirstOrThrow({ where: { userId: ada.id } });
  expect(JSON.stringify(handoff)).not.toContain(url.searchParams.get("code"));
  expect(JSON.stringify(handoff)).not.toContain(state);
});

test("without a Tuti account there is nothing to continue with", async () => {
  const before = await prisma.portalHandoff.count();
  actAs(null);
  expect(await continueToPortal(slug, randomSecret(), "/")).toEqual({ error: "Sign in to continue." });
  actAs(ada);
  expect(await continueToPortal(slug, "not-a-state", "/")).toEqual({
    error: "This sign-in link isn't valid. Go back to the portal and try again.",
  });
  expect(await continueToPortal("no-such-project", randomSecret(), "/")).toEqual({ error: "Project not found." });
  expect(await prisma.portalHandoff.count()).toBe(before);
});

test("a session a portal on its team's own site starts doesn't work on the app host", async () => {
  // Ada owns a project of her own; the portal's team puts its portal under a path of their site,
  // whose server sees every request and response there (cookies included).
  const own = await createProject(ada);
  const portal = await prisma.project.findUniqueOrThrow({ where: { slug } });
  await prisma.siteMount.create({
    data: { projectId: portal.id, origin: "https://attacker.example", path: "/portal", verificationToken: "t", verifiedAt: new Date() },
  });
  forgetCustomDomain("");

  // The team picked the state; Ada clicks Continue on the app host, and the code goes to their site.
  const state = randomSecret();
  const url = await confirm(state);
  expect(url.origin).toBe("https://attacker.example");

  // The site's server passes the callback on to Tuti and reads the session cookie Tuti sets.
  const headers = new Headers({ host: portalHost(), cookie: `${HANDOFF_STATE_COOKIE}=${state}` });
  const path = url.pathname.replace(/^\/portal/, "");
  const response = await auth.handler(new Request(`http://${portalHost()}${path}${url.search}`, { headers }));
  const stolen = response.headers
    .getSetCookie()
    .filter((c) => !c.startsWith(`${HANDOFF_STATE_COOKIE}=`))
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(stolen).toMatch(/session_token=/);

  // Presented on the app host, that portal session must not be Ada's account.
  actAs({ ...ada, cookie: stolen });
  expect(await getAccountSession()).toBeNull();
  expect(await getOwnerProject(own.slug)).toBeNull();
  request.host = APP_HOST;
  expect(await getSession()).toBeNull();
  // Better Auth's own endpoints there don't take it either.
  const getSessionOn = (host: string) => auth.handler(new Request(`http://${host}/api/auth/get-session`, { headers: { host, cookie: stolen } }));
  expect(await (await getSessionOn(APP_HOST)).json()).toBeNull();
  expect(await (await getSessionOn(portalHost())).json()).toMatchObject({ user: { id: ada.id } });

  // It's Ada on the portal that started it, and on no other.
  request.host = portalHost();
  expect((await getSession())?.user.id).toBe(ada.id);
  request.host = portalHost(own.slug);
  expect(await getSession()).toBeNull();

  // On that portal, actions name their project: it acts in that portal's project only, never as her account.
  request.host = portalHost();
  expect(await getAccountSession()).toBeNull();
  expect(await getOwnerProject(own.slug)).toBeNull();
  const post = (projectSlug: string) => {
    const form = new FormData();
    form.set("projectSlug", projectSlug);
    form.set("boardSlug", "feature-requests");
    form.set("title", "Posted as Ada");
    return createPost({}, form);
  };
  expect(await post(own.slug)).toEqual({ error: "Board not found" });
  expect(await post(slug)).toEqual({});
  // Nor is it the team's, even on its own project: whoever runs the portal's site may be on its team too.
  await prisma.teamMember.create({ data: { projectId: portal.id, userId: ada.id, role: "OWNER" } });
  expect(await getOwnerProject(slug)).toBeNull();

  // Her own idea in her project, posted on the app: on the portal, it isn't hers.
  actAs(ada);
  request.host = APP_HOST;
  expect(await post(own.slug)).toEqual({});
  actAs({ ...ada, cookie: stolen });
  request.host = portalHost();
  expect(await widgetIdeas(own.slug, null, true)).toEqual([]);
  expect((await findSimilarPosts(own.slug, "Posted as Ada")).map((idea) => idea.voted)).toEqual([false]);

  // Nor does it read, answer or message as her in her own project (private, with Messages on), or change her account.
  await prisma.article.create({ data: { projectId: own.id, slug: "setup", title: "Setup", body: "Steps.", publishedAt: new Date() } });
  expect(await answerArticle(own.slug, "setup", false, "From the portal's team")).toEqual({});
  expect(await prisma.articleFeedback.count({ where: { readerId: ada.id } })).toBe(0);
  await prisma.project.update({ where: { id: own.id }, data: { portalAccess: "PRIVATE", supportInbox: true } });
  expect(await mayRead(own.id)).toBe(false);
  expect(await portalReaderHome(own.id)).toBeNull();
  expect(await widgetPerson(own.slug, {})).toBeNull();
  expect(await askAPerson(own.slug)).toEqual({ email: "" });
  expect((await portalPreview(own.slug, "/feedback")).token).toBeUndefined();
  expect(await setAutopilotEmails("OFF")).toEqual({ error: "Sign in first" });
  expect(await setAvatar(null)).toEqual({ error: "Sign in to change your photo" });

  // Better Auth's own endpoints on the portal: its account page's rename, nothing else of her account.
  const api = (path: string, body?: object, cookie = stolen) =>
    auth.handler(
      new Request(`http://${portalHost()}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: { host: portalHost(), cookie, origin: `http://${portalHost()}`, ...(body && { "content-type": "application/json" }) },
        body: body && JSON.stringify(body),
      }),
    );
  expect((await api("/update-user", { image: "https://tracker.example/pixel.png" })).status).toBe(401);
  // Nor her name, which is her account's everywhere: that's changed on the app.
  expect((await api("/update-user", { name: "Ada L." })).status).toBe(401);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: ada.id } })).name).toBe("Ada");
  expect((await api("/list-sessions")).status).toBe(404);
  expect((await api("/revoke-session", { token: "x" })).status).toBe(404);
  expect((await api("/revoke-sessions", {})).status).toBe(404);
  expect((await api("/revoke-other-sessions", {})).status).toBe(404);
  // However the cookie is written.
  const spaced = stolen.replace("session_token=", "session_token =");
  expect(await (await auth.handler(new Request(`http://${APP_HOST}/api/auth/get-session`, { headers: { host: APP_HOST, cookie: spaced } }))).json()).toBeNull();
  actAs({ ...ada, cookie: spaced });
  request.host = APP_HOST;
  expect(await getSession()).toBeNull();
});

test("signing in with a password on a portal starts a session for that portal only; on the app, one for the app", async () => {
  const signIn = async (host: string) => {
    const { headers } = await auth.api.signInEmail({
      body: { email: ada.email, password: "correct horse battery staple" },
      headers: new Headers({ host }),
      returnHeaders: true,
    });
    return headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };
  const sessionOn = async (cookie: string, host: string) => {
    actAs({ ...ada, cookie });
    request.host = host;
    return (await getSession())?.user.id ?? null;
  };

  const portal = await signIn(portalHost());
  expect(await sessionOn(portal, portalHost())).toBe(ada.id);
  expect(await sessionOn(portal, APP_HOST)).toBeNull();

  const app = await signIn(APP_HOST);
  expect(await sessionOn(app, APP_HOST)).toBe(ada.id);
});

test("a session from before sessions were bound works nowhere", async () => {
  await prisma.session.updateMany({ where: { userId: ada.id }, data: { boundTo: null } });
  request.host = APP_HOST;
  expect(await getSession()).toBeNull();
  request.host = portalHost();
  expect(await getSession()).toBeNull();
});

test("on her own project's portal, a team member's session is a reader's: none of the team's powers there", async () => {
  const own = await createProject(ada);
  await prisma.board.create({ data: { projectId: own.id, slug: "internal", name: "Internal", postVisibility: "TEAM" } });
  const post = await prisma.post.create({ data: { projectId: own.id, boardId: own.boards[0]!.id, authorId: ada.id, number: 1, title: "Dark mode" } });
  await prisma.project.update({ where: { id: own.id }, data: { postCount: 1 } });
  await prisma.changelogEntry.create({ data: { projectId: own.id, number: 1, title: "Not out yet" } });
  const context = { actor: { kind: "user" as const, userId: ada.id }, projectId: own.id };
  const comment = (fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("postId", post.id);
    form.set("body", "On it");
    for (const [name, value] of Object.entries(fields)) {
      form.set(name, value);
    }
    return addComment({}, form);
  };
  const teamBoardPost = () => {
    const form = new FormData();
    form.set("projectSlug", own.slug);
    form.set("boardSlug", "internal");
    form.set("title", "Only for us");
    return createPost({}, form);
  };
  const powers = async () => ({
    seesTeamPosts: (await currentPostViewer(own.id)).team,
    readsEveryArticle: (await readerOf(own.id, ada.id)) === null,
    readsDrafts: await call(getChangelogEntry, context, { number: 1 }).then(() => true, () => false),
    note: await comment({ internal: "on" }),
    emailsVoters: await comment({ emailVoters: "on" }),
    postsOnTeamBoard: await teamBoardPost(),
  });

  // On the app, signed in there, she's the team.
  request.host = APP_HOST;
  expect(await powers()).toEqual({ seesTeamPosts: true, readsEveryArticle: true, readsDrafts: true, note: {}, emailsVoters: {}, postsOnTeamBoard: {} });

  // Signed in on the portal (the same account), she's a reader there.
  await prisma.session.updateMany({ where: { userId: ada.id }, data: { boundTo: own.id } });
  request.host = portalHost(own.slug);
  expect(await powers()).toEqual({
    seesTeamPosts: false,
    readsEveryArticle: false,
    readsDrafts: false,
    note: { error: "Only your team can write internal notes" },
    emailsVoters: { error: "Only your team can email a post's voters" },
    postsOnTeamBoard: { error: "Board not found" },
  });
  // Her comments there are a reader's: not shown as the team's when written (the answer, and comment.created's webhook),
  // nor after, there or on the app.
  expect(await comment()).toEqual({});
  expect((await call(createCommentOperation, context, { number: 1, body: "Also from the portal" })).author.team).toBe(false);
  const shownAsTeam = async () => (await call(listComments, context, { number: 1 })).comments.map((c) => c.author.team);
  expect(await shownAsTeam()).toEqual([true, false, false]);
  request.host = APP_HOST;
  await prisma.session.updateMany({ where: { userId: ada.id }, data: { boundTo: "app" } });
  // On the app the team's note is there too: her reply, her note, then the portal's comment.
  expect(await shownAsTeam()).toEqual([true, true, false, false]);

  // A private portal is hers to read only as one of its readers would be.
  await prisma.project.update({ where: { id: own.id }, data: { portalAccess: "PRIVATE" } });
  await prisma.session.updateMany({ where: { userId: ada.id }, data: { boundTo: own.id } });
  request.host = portalHost(own.slug);
  expect(await mayRead(own.id)).toBe(false);
  expect(await portalVisitor(own.slug, new Headers({ host: portalHost(own.slug), cookie: ada.cookie }))).toBe("refused");
});
