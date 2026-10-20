import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { SignJWT } from "jose";
import { beforeEach, expect, test } from "vitest";

import { generateSsoSecret } from "@/lib/sso";
import { createProject, signUp } from "@/test/helpers";

import { widgetCreatePost, widgetSignIn } from "./widget";

let project: Awaited<ReturnType<typeof createProject>>;
let secret: string;

beforeEach(async () => {
  project = await createProject(await signUp());
  secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
});

/** A sign-in token from the project's own app, as its server would make it. */
function ssoToken(sub = `user-${randomUUID()}`, key = secret) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, jti: randomUUID(), name: "Ada from the app", email: `e2e-${randomUUID()}@example.com` })
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
  // With the email the app gave, which "Ask a person" starts with.
  expect(signedIn).toEqual({ token: expect.any(String), name: "Ada from the app", email: expect.stringMatching(/^e2e-.*@example\.com$/) });
  expect(await widgetSignIn(project.slug, jwt)).toEqual({ error: "Couldn't sign you in" }); // used once

  const { token } = signedIn as { token: string };
  expect(await widgetCreatePost(project.slug, token, {}, form("Dark mode"))).toEqual({});
  const post = await prisma.post.findFirstOrThrow({
    where: { projectId: project.id, title: "Dark mode" },
    select: { author: { select: { name: true, ssoIdentity: { select: { externalId: true } } } } },
  });
  expect(post.author).toEqual({ name: "Ada from the app", ssoIdentity: { externalId: "app-user-1" } });
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
