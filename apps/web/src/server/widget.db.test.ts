import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { SignJWT } from "jose";
import { beforeEach, expect, test, vi } from "vitest";

import { generateSsoSecret } from "@/lib/sso";
import { widgetToken } from "@/lib/widget-session";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { findSimilarPosts } from "./similar-posts";
import { widgetCreatePost, widgetIdeas, widgetSignIn, widgetVote } from "./widget";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let secret: string;

beforeEach(async () => {
  actAs(null);
  owner = await signUp();
  project = await createProject(owner);
  secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
});

/** A sign-in token from the project's own app, as its server would make it. */
function ssoToken(sub = `user-${randomUUID()}`, key = secret, name: string | null = "Ada from the app") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, jti: randomUUID(), ...(name && { name }), email: `e2e-${randomUUID()}@example.com` })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(key));
}

const form = (title: string) => {
  const data = new FormData();
  data.set("boardSlug", "feature-requests");
  data.set("title", title);
  return data;
};

test("the widget trades an SSO token for its own, once, and posts as that person", async () => {
  const jwt = await ssoToken("app-user-1");
  const signedIn = await widgetSignIn(project.slug, jwt);
  // With their account's id and the email the app gave, which "Ask a person" starts with.
  const user = await prisma.ssoIdentity.findFirstOrThrow({ where: { externalId: "app-user-1" }, select: { userId: true } });
  expect(signedIn).toEqual({ id: user.userId, token: expect.any(String), name: "Ada from the app", named: true, email: expect.stringMatching(/^e2e-.*@example\.com$/) });
  expect(await widgetSignIn(project.slug, jwt)).toEqual({ error: "Couldn't sign you in" }); // used once

  const { token } = signedIn as { token: string };
  expect(await widgetCreatePost(project.slug, token, {}, form("Dark mode"))).toEqual({});
  const post = await prisma.post.findFirstOrThrow({
    where: { projectId: project.id, title: "Dark mode" },
    select: { author: { select: { name: true, ssoIdentity: { select: { externalId: true } } } } },
  });
  expect(post.author).toEqual({ name: "Ada from the app", ssoIdentity: { externalId: "app-user-1" } });
});

test("without a name from the app, the name made up from their email isn't one to greet them by", async () => {
  expect(await widgetSignIn(project.slug, await ssoToken("app-user-2", secret, null))).toMatchObject({ name: expect.stringMatching(/^e2e-/), named: false });
});

test("tokens that aren't this project's sign nobody in and post nothing", async () => {
  expect(await widgetSignIn(project.slug, await ssoToken(undefined, generateSsoSecret()))).toEqual({ error: "Couldn't sign you in" });
  expect(await widgetSignIn(project.slug, "not-a-jwt")).toEqual({ error: "Couldn't sign you in" });

  // A widget token from another project, or a made-up one, can't post here.
  const other = await createProject(await signUp());
  const otherSecret = generateSsoSecret();
  await prisma.project.update({ where: { id: other.id }, data: { ssoSecret: otherSecret } });
  const elsewhere = (await widgetSignIn(other.slug, await ssoToken(undefined, otherSecret))) as { token: string };
  expect(await widgetCreatePost(project.slug, elsewhere.token, {}, form("Sneaky"))).toEqual({ error: "Sign in to post feedback" });
  expect(await widgetCreatePost(project.slug, "made.up.token", {}, form("Sneaky"))).toEqual({ error: "Sign in to post feedback" });
  expect(await prisma.post.count({ where: { projectId: project.id } })).toBe(0);
});

test("without SSO set up, the widget says so", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: null } });
  expect(await widgetSignIn(project.slug, await ssoToken())).toEqual({ error: "Single sign-on isn't set up for this project" });
});

/** A post on `in`'s first board (or `board`), `daysAgo` old. */
let posts = 0;
const post = (title: string, data: { daysAgo?: number; voteCount?: number; status?: "COMPLETED"; authorId?: string; in?: typeof project; board?: string } = {}) => {
  const where = data.in ?? project;
  return prisma.post.create({
    data: {
      projectId: where.id,
      boardId: data.board ?? where.boards[0]!.id,
      authorId: data.authorId ?? owner.id,
      number: ++posts,
      title,
      body: "",
      voteCount: data.voteCount ?? 0,
      status: data.status,
      createdAt: new Date(Date.now() - (data.daysAgo ?? 0) * 86_400_000),
    },
  });
};

test("the widget lists the project's trending ideas, not shipped ones nor other projects', with its person's votes; Mine is what they posted or voted for", async () => {
  const fan = await signUp("Fan");
  await post("Old favourite", { daysAgo: 30, voteCount: 5 });
  const newHit = await post("New hit", { daysAgo: 2, voteCount: 1 });
  await prisma.vote.create({ data: { postId: newHit.id, userId: fan.id, projectId: project.id } });
  await post("Shipped", { daysAgo: 1, voteCount: 9, status: "COMPLETED", authorId: fan.id });
  await post("Elsewhere", { voteCount: 50, in: await createProject(await signUp()) });
  // Every board's, not only the one the widget posts to.
  const bugs = await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  const crash = await post("Crash on save", { daysAgo: 3, voteCount: 2, board: bugs.id });

  // This week's votes first, then the most votes; signed out, none of them voted for.
  const titles = (ideas: { title: string }[]) => ideas.map((idea) => idea.title);
  const signedOut = await widgetIdeas(project.slug, null);
  expect(titles(signedOut)).toEqual(["New hit", "Old favourite", "Crash on save"]);
  expect(signedOut.find((idea) => idea.title === "Crash on save")?.board).toEqual({ slug: "bugs" });
  expect(signedOut.every((idea) => !idea.voted)).toBe(true);
  expect(await widgetIdeas(project.slug, null, true)).toEqual([]);

  // As the person the customer's page signed in, or the portal's own signed-in user.
  const token = widgetToken(project.id, fan.id);
  expect((await widgetIdeas(project.slug, token)).map((idea) => [idea.title, idea.voted])).toEqual([
    ["New hit", true],
    ["Old favourite", false],
    ["Crash on save", false],
  ]);
  expect(titles(await widgetIdeas(project.slug, token, true))).toEqual(["Shipped", "New hit"]);
  // Voted for, the other board's idea is theirs too.
  expect(await widgetVote(project.slug, token, crash.id, true)).toEqual({ votes: 3 });
  expect(titles(await widgetIdeas(project.slug, token, true))).toEqual(["Shipped", "New hit", "Crash on save"]);
  actAs(fan);
  expect(titles(await widgetIdeas(project.slug, null, true))).toEqual(["Shipped", "New hit", "Crash on save"]);
});

test("a private portal's widget lists ideas only to those who may read it", async () => {
  await post("Secret plan", { voteCount: 1 });
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  const outsider = await signUp("Outsider");
  expect(await widgetIdeas(project.slug, null)).toEqual([]);
  // A token isn't a way in: the panel reads a private portal by its reader cookie (see portal-access.ts).
  expect(await widgetIdeas(project.slug, widgetToken(project.id, outsider.id), true)).toEqual([]);
  actAs(outsider);
  expect(await widgetIdeas(project.slug, null)).toEqual([]);
  actAs(owner);
  expect((await widgetIdeas(project.slug, null)).map((idea) => idea.title)).toEqual(["Secret plan"]);
});

test("the widget votes as its person, and takes the vote back; nobody else's and not other projects' posts", async () => {
  const fan = await signUp("Fan");
  const idea = await post("Dark mode", { voteCount: 5 });
  const token = widgetToken(project.id, fan.id);
  expect(await widgetVote(project.slug, token, idea.id, true)).toEqual({ votes: 6 });
  expect(await widgetVote(project.slug, token, idea.id, true)).toEqual({ votes: 6 });
  expect(await prisma.vote.count({ where: { postId: idea.id, userId: fan.id } })).toBe(1);
  expect(await widgetVote(project.slug, token, idea.id, false)).toEqual({ votes: 5 });

  expect(await widgetVote(project.slug, null, idea.id, true)).toEqual({ error: "Sign in to vote" });
  expect(await widgetVote(project.slug, "made.up.token", idea.id, true)).toEqual({ error: "Sign in to vote" });
  const elsewhere = await post("Elsewhere", { in: await createProject(await signUp()) });
  expect(await widgetVote(project.slug, token, elsewhere.id, true)).toEqual({ error: "Post not found" });

  // On the portal's own site, its signed-in user.
  actAs(fan);
  expect(await widgetVote(project.slug, null, idea.id, true)).toEqual({ votes: 6 });
});

test("similar ideas say whether whoever's asking voted for them: the widget's person, or the portal's signed-in user", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const fan = await signUp("Fan");
  const idea = await post("Dark mode for the dashboard", { voteCount: 1 });
  await prisma.vote.create({ data: { postId: idea.id, userId: fan.id, projectId: project.id } });
  const similar = async (token?: string) => (await findSimilarPosts(project.slug, "dark mode", token)).map((found) => [found.title, found.voted]);
  expect(await similar(widgetToken(project.id, fan.id))).toEqual([["Dark mode for the dashboard", true]]);
  expect(await similar("made.up.token")).toEqual([["Dark mode for the dashboard", false]]);
  expect(await similar()).toEqual([["Dark mode for the dashboard", false]]);
  actAs(fan);
  expect(await similar()).toEqual([["Dark mode for the dashboard", true]]);
});

test("a private portal's reader whose access the team takes away can't vote or post from the widget, though their token hasn't expired", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  const reader = await signUp("Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  const access = await prisma.portalReader.create({ data: { projectId: project.id, email: reader.email } });
  const idea = await post("Dark mode", { voteCount: 1 });
  const token = widgetToken(project.id, reader.id);
  expect(await widgetVote(project.slug, token, idea.id, true)).toEqual({ votes: 2 });

  await prisma.portalReader.delete({ where: { id: access.id } });
  expect(await widgetVote(project.slug, token, idea.id, false)).toEqual({ error: "Sign in to vote" });
  expect(await widgetCreatePost(project.slug, token, {}, form("Sneaky"))).toEqual({ error: "Sign in to post feedback" });
  expect(await prisma.post.count({ where: { projectId: project.id, title: "Sneaky" } })).toBe(0);
  expect((await prisma.post.findUniqueOrThrow({ where: { id: idea.id } })).voteCount).toBe(2);
});
