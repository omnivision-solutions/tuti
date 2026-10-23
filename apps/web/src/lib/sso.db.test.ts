import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { SignJWT } from "jose";
import { beforeEach, describe, expect, test } from "vitest";

import { GET } from "@/app/portal/[project]/(site)/sso/route";
import { acceptInvitation } from "@/server/invitations";
import { createProject as createProjectAction } from "@/server/projects";
import { getSession } from "@/server/session";
import { actAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { hashInvitationToken } from "./invitations";
import { generateSsoSecret } from "./sso";

let slug: string;
let projectId: string;
let secret: string;

beforeEach(async () => {
  const project = await createProject(await signUp("Owner"));
  slug = project.slug;
  projectId = project.id;
  secret = generateSsoSecret();
  await prisma.project.update({ where: { id: projectId }, data: { ssoSecret: secret } });
});

type Claims = { sub?: string; jti?: string; iat?: number; exp?: number; email?: string; name?: string; attributes?: unknown; properties?: unknown };

/** A token as the project's app would sign it; `claims` override the defaults. */
function token(claims: Claims = {}, { key = secret, alg = "HS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: "user-1", jti: randomUUID(), iat: now, exp: now + 60, name: "Ada", ...claims };
  return new SignJWT(payload).setProtectedHeader({ alg }).sign(new TextEncoder().encode(key));
}

/** Opens <portal>/sso like the user's browser would. */
async function visit(jwt: string, { redirect, host = `${slug}.localhost:3100` }: { redirect?: string; host?: string } = {}) {
  const url = new URL(`http://${host}/sso`);
  url.searchParams.set("token", jwt);
  if (redirect !== undefined) {
    url.searchParams.set("redirect", redirect);
  }
  const response = await GET(new Request(url, { headers: { host } }));
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { location: response.headers.get("location"), cookie };
}

const ssoUsers = () => prisma.ssoIdentity.findMany({ where: { projectId }, include: { user: true } });

test("signs a new user in and sends them to the requested page", async () => {
  const result = await visit(await token({ email: "ada@example.com" }), { redirect: "/feedback/ideas?sort=top" });

  expect(result.location).toBe("/feedback/ideas?sort=top");
  const [identity, ...others] = await ssoUsers();
  expect(others).toEqual([]);
  expect(identity).toMatchObject({ externalId: "user-1", email: "ada@example.com", user: { name: "Ada" } });
  // The asserted email is never the account's email: a project could claim anyone's.
  expect(identity!.user.email).toMatch(/@users\.tuti\.invalid$/);

  actAs({ id: identity!.userId, email: "", cookie: result.cookie });
  expect((await getSession())?.user.id).toBe(identity!.userId);
  // Their email is a placeholder: no verification email goes out.
  expect(mailbox.emails.filter((e) => e.to.includes(identity!.user.email))).toEqual([]);
});

test("the same `sub` is the same user, with an updated profile", async () => {
  await visit(await token({ name: "Ada" }));
  await visit(await token({ name: "Ada Lovelace" }));
  const identities = await ssoUsers();
  expect(identities).toHaveLength(1);
  expect(identities[0]!.user.name).toBe("Ada Lovelace");
});

test("each sign-in's `properties` set the ones they name and remove the null ones; bad ones are dropped and the sign-in still works", async () => {
  const properties = async () => (await ssoUsers()).map((identity) => identity.properties);
  const first = await visit(
    await token({ properties: { plan: "pro", seats: 12, admin: true, features: ["sso"], nested: { a: 1 }, mixed: ["a", 1], gone: null } }),
    { redirect: "/docs" },
  );
  expect(first.location).toBe("/docs");
  expect(await properties()).toEqual([{ plan: "pro", seats: 12, admin: true, features: ["sso"] }]);
  await visit(await token({ properties: { plan: "free", admin: null } }));
  expect(await properties()).toEqual([{ plan: "free", seats: 12, features: ["sso"] }]);
  // Not an object: no change, and still signed in.
  expect((await visit(await token({ properties: "pro" }), { redirect: "/docs" })).location).toBe("/docs");
  // Left out: no change either (the API may have set them).
  await visit(await token());
  expect(await properties()).toEqual([{ plan: "free", seats: 12, features: ["sso"] }]);
});

test("`attributes`, their old name, still work; `properties` wins where both name one", async () => {
  await visit(await token({ attributes: { plan: "pro", role: "admin" }, properties: { plan: "enterprise" } }));
  expect((await ssoUsers()).map((identity) => identity.properties)).toEqual([{ plan: "enterprise", role: "admin" }]);
});

test("a user has at most 50 properties: a sign-in's new ones past that are left out", async () => {
  await visit(await token({ properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, i])) }));
  await visit(await token({ properties: { p0: "changed", extra: true } }));
  const [identity] = await ssoUsers();
  expect(Object.keys(identity!.properties as object)).toHaveLength(50);
  expect(identity!.properties).toMatchObject({ p0: "changed" });
  expect(identity!.properties).not.toHaveProperty("extra");
});

test("the asserted email is kept lowercase, and a sign-in without one clears it", async () => {
  await visit(await token({ email: "Ada@Example.COM" }));
  expect((await ssoUsers()).map((identity) => identity.email)).toEqual(["ada@example.com"]);
  await visit(await token());
  expect((await ssoUsers()).map((identity) => identity.email)).toEqual([null]);
});

test("the migration keeps attributes as properties and lowercases emails", async () => {
  const sql = readFileSync(new URL("../../../../packages/db/prisma/migrations/20261023120000_user_properties/migration.sql", import.meta.url), "utf8");
  // Back to before it (this file's database is its own), with a user as they were then.
  await prisma.$executeRawUnsafe(`
    DROP INDEX "sso_identity_projectId_email_idx";
    ALTER TABLE "sso_identity" RENAME COLUMN "properties" TO "attributes";`);
  const user = await signUp("Then");
  await prisma.$executeRaw`INSERT INTO sso_identity (id, "projectId", "externalId", "userId", email, attributes, "updatedAt")
    VALUES ('s1', ${projectId}, 'user-1', ${user.id}, 'Ada@Example.COM', '{"plan": "pro"}', now())`;

  await prisma.$executeRawUnsafe(sql);

  expect(await prisma.ssoIdentity.findMany({ where: { projectId }, select: { email: true, properties: true } })).toEqual([
    { email: "ada@example.com", properties: { plan: "pro" } },
  ]);
});

test("the same `sub` in another project is someone else", async () => {
  const other = await createProject(await signUp("Other owner"));
  const otherSecret = generateSsoSecret();
  await prisma.project.update({ where: { id: other.id }, data: { ssoSecret: otherSecret } });

  await visit(await token());
  await visit(await token({}, { key: otherSecret }), { host: `${other.slug}.localhost:3100` });

  const users = await prisma.ssoIdentity.findMany({
    where: { externalId: "user-1", projectId: { in: [projectId, other.id] } },
    select: { userId: true },
  });
  expect(new Set(users.map((u) => u.userId)).size).toBe(2);
});

describe("refuses", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const refusal = (code: string) => ({ location: `/sso/error?code=${code}`, cookie: "" });

  test("a token used twice", async () => {
    const jwt = await token();
    await visit(jwt);
    expect(await visit(jwt)).toEqual(refusal("token_already_used"));
  });

  test("an expired token", async () => {
    expect(await visit(await token({ iat: now() - 600, exp: now() - 120 }))).toEqual(refusal("expired_token"));
  });

  test("a token that lives longer than 10 minutes", async () => {
    expect(await visit(await token({ exp: now() + 3600 }))).toEqual(refusal("token_lifetime_too_long"));
  });

  test("a token issued in the future", async () => {
    expect(await visit(await token({ iat: now() + 300, exp: now() + 360 }))).toEqual(refusal("token_lifetime_too_long"));
  });

  test("a token signed with another secret or algorithm", async () => {
    expect(await visit(await token({}, { key: generateSsoSecret() }))).toEqual(refusal("invalid_token"));
    expect(await visit(await token({}, { alg: "HS512" }))).toEqual(refusal("invalid_token"));
  });

  test("a token with bad claims", async () => {
    expect(await visit(await token({ email: "not an email" }))).toEqual(refusal("invalid_claims"));
  });

  test("a token for a project without SSO", async () => {
    await prisma.project.update({ where: { id: projectId }, data: { ssoSecret: null } });
    expect(await visit(await token())).toEqual(refusal("sso_not_enabled"));
  });

  test("redirects off the portal", async () => {
    for (const redirect of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      expect((await visit(await token(), { redirect })).location).toBe("/");
    }
  });

  test("sign-ins on the app host", async () => {
    expect(await visit(await token(), { host: "tuti.localhost:3100" })).toEqual({ location: "/", cookie: "" });
    expect(await ssoUsers()).toEqual([]);
  });
});

describe("SSO users only exist in their project's portal", () => {
  async function ssoUser() {
    const { cookie } = await visit(await token());
    const [identity] = await ssoUsers();
    return { id: identity!.userId, email: identity!.user.email, cookie };
  }

  test("they can't create projects", async () => {
    actAs(await ssoUser());
    const form = new FormData();
    form.set("name", "Sneaky");
    form.set("slug", `sneaky-${randomUUID().slice(0, 8)}`);
    expect(await createProjectAction({}, form)).toEqual({ error: "Sign in to create a project" });
  });

  test("they can't join a team, even with an invite", async () => {
    const owner = await signUp("Inviting owner");
    const project = await createProject(owner);
    // A link-only invite (no email), which any signed-in account could otherwise accept.
    const token = randomUUID();
    await prisma.invitation.create({
      data: {
        projectId: project.id,
        tokenHash: hashInvitationToken(token),
        createdById: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    actAs(await ssoUser());
    expect(await acceptInvitation(token)).toEqual({ error: "Sign in to accept this invite" });
    expect(await prisma.teamMember.count({ where: { projectId: project.id } })).toBe(1);
  });
});
