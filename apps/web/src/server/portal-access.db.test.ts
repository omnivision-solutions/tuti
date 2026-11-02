import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, expect, test } from "vitest";

import { GET as api } from "@/app/api/v1/[...path]/route";
import { GET as latest } from "@/app/api/widget/latest/route";
import { GET as robots } from "@/app/portal/[project]/(site)/robots.txt/route";
import SignUpPage from "@/app/portal/[project]/(site)/sign-up/page";
import WidgetPage from "@/app/portal/[project]/widget/page";
import { WidgetLocked } from "@/components/widget-locked";
import { previewToken } from "@/lib/preview-session";
import { widgetToken } from "@/lib/widget-session";
import { proxy } from "@/proxy";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { createApiKey } from "./api-keys";
import * as changelog from "./changelog";
import * as changelogSeen from "./changelog-seen";
import * as docsReaders from "./docs-readers";
import { canActIn } from "./membership";
import { canReadPortal, mayRead, PREVIEW_READER_COOKIE, WIDGET_READER_COOKIE } from "./portal-access";
import * as posts from "./posts";
import { confirmSignInLink, emailSignInLink } from "./sign-in-link";
import * as similarPosts from "./similar-posts";

/**
 * A private portal (Settings → Portal access): every reader of a portal's content, for each
 * kind of visitor, on a public and a private portal. Only the team, the project's SSO users and
 * the readers it added by email (verified) read a private one; signing up, a sign-in link, an
 * unverified reader's address or another project's team gets nobody in.
 */

type Project = Awaited<ReturnType<typeof createProject>>;
let owner: TestUser;
let project: Project;
const VISITORS = ["signed out", "signed up", "team", "SSO user", "reader", "unverified reader"] as const;
let visitors: Record<(typeof VISITORS)[number], TestUser | null>;
let fixture: { postId: string; questionId: string };

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};

/** Someone the team added as a reader by email, verified or not. */
async function readerOf(projectId: string, verified: boolean) {
  const user = await signUp("Reader");
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: verified } });
  await prisma.portalReader.create({ data: { projectId, email: user.email.toLowerCase() } });
  return user;
}

async function ssoUserOf(projectId: string) {
  const user = await signUp("From the app");
  await prisma.ssoIdentity.create({ data: { projectId, externalId: `ext-${randomUUID()}`, userId: user.id } });
  return user;
}

/** A portal with something in every reader: a post, a published changelog entry, an article and an answered question. */
async function portalWithContent(owner: TestUser) {
  const project = await createProject(owner);
  const projectId = project.id;
  const post = await prisma.post.create({
    data: { projectId, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Dark mode", body: "" },
  });
  await prisma.project.update({ where: { id: projectId }, data: { postCount: 1, changelogCount: 1 } });
  await prisma.changelogEntry.create({ data: { projectId, number: 1, title: "Dark mode is here", publishedAt: new Date(), announced: true } });
  await prisma.article.create({ data: { projectId, slug: "getting-started", title: "Getting started", body: "Hello", publishedAt: new Date() } });
  const question = await prisma.docsQuestion.create({
    data: { projectId, askerId: "a-reader", question: "How do I start?", source: "PORTAL", status: "ANSWERED", answer: "Sign up." },
  });
  return { project, fixture: { postId: post.id, questionId: question.id } };
}

beforeAll(async () => {
  owner = await signUp("Owner");
  ({ project, fixture } = await portalWithContent(owner));
  visitors = {
    "signed out": null,
    "signed up": await signUp("Stranger"),
    team: owner,
    "SSO user": await ssoUserOf(project.id),
    reader: await readerOf(project.id, true),
    "unverified reader": await readerOf(project.id, false),
  };
});

beforeEach(() => {
  actAs(null);
  request.headers = {};
});

const setAccess = (projectId: string, access: "PUBLIC" | "PRIVATE") =>
  prisma.project.update({ where: { id: projectId }, data: { portalAccess: access } });

/** Opens `path` on the portal's host as whoever actAs() signed in: served, or sent to sign in. */
async function visit(slug: string, path: string): Promise<"served" | `sign in: ${string}`> {
  const host = `${slug}.localhost:3100`;
  const response = await proxy(new NextRequest(`http://${host}${path}`, { headers: { host, cookie: request.cookie } }));
  if (response.headers.get("x-middleware-rewrite")) {
    return "served";
  }
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin).toBe(`http://${host}`);
  return `sign in: ${location.pathname}${location.search}`;
}

/** Whether a React element tree (not rendered) contains an element of `type`. */
function contains(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => contains(child, type));
  }
  const element = node as { type?: unknown; props?: { children?: unknown } } | null;
  return !!element && typeof element === "object" && (element.type === type || contains(element.props?.children, type));
}

const widgetShows = async (slug: string) =>
  !contains(
    await WidgetPage({ params: Promise.resolve({ project: slug }), searchParams: Promise.resolve({}) } as PageProps<"/portal/[project]/widget">),
    WidgetLocked,
  );

async function articleViews() {
  const rows = await prisma.articleViewDay.findMany({ where: { article: { projectId: project.id } }, select: { views: true } });
  return rows.reduce((sum, row) => sum + row.views, 0);
}

/** Every reader of a portal's content, and whether it served this visitor. `account`: only for someone signed in, even when public. */
const readers: { name: string; account?: true; served: (slug: string) => Promise<boolean> }[] = [
  ...[
    "/",
    "/feedback/feature-requests",
    "/feedback/feature-requests/dark-mode-1",
    "/roadmap",
    "/changelog",
    "/changelog/1",
    "/changelog/rss.xml",
    "/docs",
    "/docs?q=start",
    "/docs/getting-started",
    "/docs/getting-started.md",
    "/llms.txt",
    "/sitemap.xml",
    "/account",
  ].map((path) => ({ name: `page ${path}`, served: async (slug: string) => (await visit(slug, path)) === "served" })),
  { name: "the widget's panel", served: widgetShows },
  {
    name: "AI answers (askDocs)",
    // Without AI set up here, a reader is told so; anyone else, that there are no such docs.
    served: async (slug) => {
      const result = await docsReaders.askDocs(slug, "How do I start?");
      return !("error" in result && result.error === "Docs not found");
    },
  },
  { name: "was this helpful (answerArticle)", served: async (slug) => !(await docsReaders.answerArticle(slug, "getting-started", true)).error },
  {
    name: "article views (countArticleView)",
    served: async (slug) => {
      const before = await articleViews();
      await docsReaders.countArticleView(slug, "getting-started");
      return (await articleViews()) > before;
    },
  },
  { name: "rating an answer (rateDocsAnswer)", served: async (slug) => !(await docsReaders.rateDocsAnswer(slug, fixture.questionId, true)).error },
  {
    // Refused readers get "not found" before anything else is checked.
    name: "asking a person (escalateDocs)",
    served: async (slug) => (await docsReaders.escalateDocs(slug, fixture.questionId, "e2e-reader@example.com", "")).error !== "Docs not found",
  },
  { name: "similar posts while typing (findSimilarPosts)", served: async (slug) => (await similarPosts.findSimilarPosts(slug, "Dark mode please")).length > 0 },
  {
    name: "posting (createPost)",
    account: true,
    served: async (slug) => !(await posts.createPost({}, form({ projectSlug: slug, boardSlug: "feature-requests", title: `Idea ${randomUUID()}` }))).error,
  },
  { name: "voting (toggleVote)", account: true, served: async () => !(await posts.toggleVote(fixture.postId)).error },
  { name: "subscribing (setPostSubscription)", account: true, served: async () => !(await posts.setPostSubscription(fixture.postId, true)).error },
  { name: "commenting (addComment)", account: true, served: async () => !(await posts.addComment({}, form({ postId: fixture.postId, body: "Me too" }))).error },
  { name: "reacting to the changelog", account: true, served: async (slug) => !(await changelog.reactToChangelogEntry(slug, 1, "tada", true)).error },
  { name: "what's new seen", account: true, served: async (slug) => !(await changelogSeen.markChangelogSeen(slug, new Date().toISOString())).error },
];

const cases = (["PUBLIC", "PRIVATE"] as const).flatMap((access) =>
  VISITORS.flatMap((visitor) =>
    readers.map((reader) => {
      const expected =
        access === "PUBLIC" ? !reader.account || visitor !== "signed out" : visitor === "team" || visitor === "SSO user" || visitor === "reader";
      return { access, visitor, reader, expected };
    }),
  ),
);

test.each(cases)("$access portal, $visitor: $reader.name → $expected", async ({ access, visitor, reader, expected }) => {
  await setAccess(project.id, access);
  actAs(visitors[visitor]);
  expect(await reader.served(project.slug)).toBe(expected);
});

test("a private portal sends visitors to sign in and back to where they were; signing in stays open", async () => {
  await setAccess(project.id, "PRIVATE");
  expect(await visit(project.slug, "/")).toBe("sign in: /sign-in");
  expect(await visit(project.slug, "/docs/getting-started.md")).toBe(`sign in: /sign-in?${new URLSearchParams({ next: "/docs/getting-started.md" })}`);
  expect(await visit(project.slug, "/docs?q=start")).toBe(`sign in: /sign-in?${new URLSearchParams({ next: "/docs?q=start" })}`);
  for (const path of ["/sign-in", "/sign-in/link", "/sign-up", "/forgot-password", "/reset-password", "/sso", "/sso/error", "/continue", "/unsubscribe", "/robots.txt", "/widget"]) {
    expect(await visit(project.slug, path), path).toBe("served");
  }
  // A changelog email's unsubscribe link works signed out, even once the portal is private (its subscribers get nothing more).
  for (const path of ["/changelog/subscription", "/changelog/subscription/unsubscribe"]) {
    expect(await visit(project.slug, path), path).toBe("served");
  }
  expect(await visit(project.slug, "/changelog")).toBe(`sign in: /sign-in?${new URLSearchParams({ next: "/changelog" })}`);
  // Allowed readers' feeds and files are theirs: no shared cache may keep them.
  actAs(owner);
  const host = `${project.slug}.localhost:3100`;
  const response = await proxy(new NextRequest(`http://${host}/llms.txt`, { headers: { host, cookie: owner.cookie } }));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("robots.txt keeps crawlers out of a private portal", async () => {
  const get = async () => (await robots(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  await setAccess(project.id, "PUBLIC");
  expect(await get()).toContain("Allow: /\n");
  await setAccess(project.id, "PRIVATE");
  expect(await get()).toBe("User-agent: *\nDisallow: /\n");
});

test("the widget script isn't told when a private portal last announced something", async () => {
  const ask = async () =>
    ((await (await latest(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${project.slug}`))).json()) as { latest: string | null }).latest;
  await setAccess(project.id, "PUBLIC");
  expect(await ask()).not.toBeNull();
  await setAccess(project.id, "PRIVATE");
  expect(await ask()).toBeNull();
});

test("in the widget on a customer's site, the person their app signs in (the reader cookie) reads a private portal; another project's token doesn't", async () => {
  await setAccess(project.id, "PRIVATE");
  const other = await createProject(owner);
  const sso = visitors["SSO user"]!;
  request.cookie = `${WIDGET_READER_COOKIE}=${widgetToken(project.id, sso.id)}`;
  expect(await widgetShows(project.slug)).toBe(true);
  expect(await docsReaders.askDocs(project.slug, "How do I start?")).not.toEqual({ error: "Docs not found" });
  request.cookie = `${WIDGET_READER_COOKIE}=${widgetToken(other.id, sso.id)}`;
  expect(await widgetShows(project.slug)).toBe(false);
  request.cookie = `${WIDGET_READER_COOKIE}=not-a-token`;
  expect(await widgetShows(project.slug)).toBe(false);
});

test("Customize's preview reads a private portal as the team member looking: its token becomes a cookie, out of the address", async () => {
  await setAccess(project.id, "PRIVATE");
  const host = `${project.slug}.localhost:3100`;
  const open = (path: string, cookie = "") => proxy(new NextRequest(`http://${host}${path}`, { headers: { host, cookie } }));

  // The token (the team member's, for this project) is kept as a partitioned cookie, and the address loses it.
  const token = previewToken(project.id, owner.id);
  const first = await open(`/docs?customize=1&preview-token=${token}`);
  expect(first.status).toBe(307);
  expect(first.headers.get("location")).toBe(`http://${host}/docs?customize=1`);
  const cookie = first.headers.get("set-cookie")!;
  expect(cookie).toContain(`${PREVIEW_READER_COOKIE}=${token}`);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/SameSite=none/i);
  expect(cookie).toMatch(/Partitioned/i);
  expect(first.headers.get("content-security-policy")).toMatch(/^frame-ancestors /);

  // With it, the private portal's pages are served, and its readers' checks let them read it.
  expect((await open("/docs?customize=1", `${PREVIEW_READER_COOKIE}=${token}`)).headers.get("x-middleware-rewrite")).toBeTruthy();
  request.cookie = `${PREVIEW_READER_COOKIE}=${token}`;
  expect(await mayRead(project.id)).toBe(true);

  // Anyone else's token, another project's, a forged one or an expired one gets no cookie and no way in.
  const stranger = visitors["signed up"]!;
  const other = await createProject(stranger);
  for (const bad of [previewToken(project.id, stranger.id), previewToken(other.id, owner.id), `${token}x`, previewToken(project.id, owner.id, Date.now() - 2 * 60 * 60 * 1000)]) {
    const response = await open(`/docs?customize=1&preview-token=${bad}`);
    expect(response.status).toBe(307);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await open("/docs", `${PREVIEW_READER_COOKIE}=${bad}`)).headers.get("x-middleware-rewrite")).toBeNull();
    request.cookie = `${PREVIEW_READER_COOKIE}=${bad}`;
    expect(await mayRead(project.id)).toBe(false);
  }

  // Off the team, the token stops working.
  const admin = await signUp("Admin");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  const theirs = previewToken(project.id, admin.id);
  expect((await open("/docs", `${PREVIEW_READER_COOKIE}=${theirs}`)).headers.get("x-middleware-rewrite")).toBeTruthy();
  await prisma.teamMember.deleteMany({ where: { projectId: project.id, userId: admin.id } });
  expect((await open("/docs", `${PREVIEW_READER_COOKIE}=${theirs}`)).headers.get("x-middleware-rewrite")).toBeNull();
  await setAccess(project.id, "PUBLIC");
});

test("sign-up is off on a private portal, and an account made by a sign-in link can't read it", async () => {
  await setAccess(project.id, "PRIVATE");
  const signUpPage = (next?: string) =>
    SignUpPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve(next ? { next } : {}) } as PageProps<"/portal/[project]/sign-up">);
  expect(await redirectTarget(signUpPage())).toBe("/sign-in");
  expect(await redirectTarget(signUpPage("/roadmap"))).toBe(`/sign-in?${new URLSearchParams({ next: "/roadmap" })}`);

  // A sign-in link for a new address makes an account: it's signed in, but not a reader.
  const email = `e2e-${randomUUID()}@example.com`;
  expect(await emailSignInLink(project.slug, "/", form({ email }))).toEqual({ sentTo: email });
  const message = await mailbox.latestTo(email);
  const link = new URL(message.text.split(/\s+/).find((word) => word.includes("/sign-in/link?"))!);
  request.host = link.host;
  try {
    await confirmSignInLink(form({ token: link.searchParams.get("token")!, next: "/" }));
  } finally {
    request.host = "";
  }
  const user = await prisma.user.findFirstOrThrow({ where: { email } });
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  expect(await canReadPortal({ id: project.id }, user.id)).toBe(false);
  expect(await canActIn(user.id, project.id)).toBe(false);
  // The same account reads it once the team adds it.
  await prisma.teamMember.create({ data: { projectId: project.id, userId: user.id, role: "MEMBER" } });
  expect(await canReadPortal({ id: project.id }, user.id)).toBe(true);
});

test("the team's API keys keep working on a private portal", async () => {
  await setAccess(project.id, "PRIVATE");
  actAs(owner);
  const { key } = await createApiKey(project.slug, "Private", "READ");
  actAs(null);
  const get = (path: string) =>
    api(new Request(`http://tuti.localhost:3100/api/v1/${path}`, { headers: { authorization: `Bearer ${key}` } }), {
      params: Promise.resolve({ path: path.split("/") }),
    });
  const response = await get("posts");
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).toContain("Dark mode");
  expect(await (await get("portal")).json()).toEqual({ access: "private", home: "feedback" });
});

test("one project's private portal changes nothing for other projects, and its readers don't read other private ones", async () => {
  await setAccess(project.id, "PRIVATE");
  const otherOwner = await signUp("Other owner");
  const { project: other } = await portalWithContent(otherOwner);
  const { project: otherPrivate } = await portalWithContent(otherOwner);
  await setAccess(otherPrivate.id, "PRIVATE");

  actAs(null);
  expect(await visit(other.slug, "/roadmap")).toBe("served");
  expect(await similarPosts.findSimilarPosts(other.slug, "Dark mode please")).not.toEqual([]);
  for (const reader of [owner, visitors["SSO user"]!]) {
    actAs(reader);
    expect(await visit(otherPrivate.slug, "/roadmap")).toBe(`sign in: /sign-in?${new URLSearchParams({ next: "/roadmap" })}`);
    expect(await docsReaders.answerArticle(otherPrivate.slug, "getting-started", true)).toEqual({ error: "Article not found" });
  }
});
