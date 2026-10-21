import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { generateSsoSecret, upsertProjectUser, verifySsoToken } from "@/lib/sso";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { docsContents, docsTree, everyCollection, publishedArticle } from "./docs-queries";
import { answerSections, searchDocs } from "./docs-search";
import { createArticle, createCollection, getArticle, listArticles, listCollections, publishArticle, updateCollection } from "./operations/docs";
import { createGroup, updateGroup } from "./operations/groups";
import { call } from "./operations/run";
import { groupsOf } from "./portal-access";

/**
 * Reader groups: the project's app says in its SSO token which groups someone is in, and a
 * collection can be for some groups only. Everyone else (signed out, signed up, other groups)
 * doesn't see it, its articles or the collections in it anywhere; the team sees everything.
 */

let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let secret: string;

beforeAll(async () => {
  openai = await startOpenAIFake();
});
afterAll(() => openai.close());

beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  owner = await signUp("Owner");
  project = await createProject(owner);
  secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
  actAs(null);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** Someone the project's SSO signed in, with `groups` (and a session, for actAs). */
async function ssoReader(groups: string[], externalId = `user-${randomUUID()}`) {
  const user = await signUp("From the app");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId, userId: user.id, groups } });
  return user;
}

/** The project's reader groups with these claims (named after them). */
const addGroups = (...claims: string[]) =>
  prisma.readerGroup.createMany({ data: claims.map((claim) => ({ projectId: project.id, key: claim, name: claim, claim })) });

/** A sign-in token from the project's app with `claims`, verified: the user it signs in. */
async function signIn(claims: Record<string, unknown>, sub = `user-${randomUUID()}`) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub, jti: randomUUID(), ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(secret));
  const result = await verifySsoToken({ id: project.id, ssoSecret: secret }, token);
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result.userId;
}

/**
 * Basics (everyone), Enterprise (enterprise only) with Setup inside it (everyone, but within
 * Enterprise), Beta (beta only), and an article in each plus one in no collection. Every article
 * says "widget", and each has a section close to the question "widget help".
 */
async function docsWithGroups() {
  await addGroups("enterprise", "beta");
  await call(createCollection, as(), { name: "Basics" });
  await call(createCollection, as(), { name: "Enterprise", groups: ["Enterprise"] });
  await call(createCollection, as(), { name: "Setup", parent: "enterprise" });
  await call(createCollection, as(), { name: "Beta", groups: ["beta"] });
  openai.setVector("widget help", [1, 0]);
  for (const [title, collection] of [
    ["Getting started", "basics"],
    ["SAML", "enterprise"],
    ["Rolling out", "setup"],
    ["New editor", "beta"],
    ["Contact", null],
  ] as const) {
    const body = `The ${title} widget.`;
    openai.setVector(articleChunkText(title, { heading: "", text: body }), [0.9, Math.sqrt(1 - 0.81)]);
    const { slug } = await call(createArticle, as(), { title, body, collection });
    await call(publishArticle, as(), { slug });
  }
}

const everyone = ["getting-started", "contact"];
const enterprise = [...everyone, "saml", "rolling-out"];

describe("who sees what", () => {
  beforeEach(docsWithGroups);

  /** Every way a reader reads the docs, for the user `actAs` set (or for `groups`). */
  async function seen(user: TestUser | null) {
    actAs(user);
    const userId = user?.id ?? null;
    const groups = await groupsOf(project.id, userId);
    const center = await docsContents(project.slug);
    const slugs = (await prisma.article.findMany({ where: { projectId: project.id }, select: { slug: true } })).map((a) => a.slug);
    const pages = await Promise.all(slugs.map((slug) => publishedArticle(project.slug, slug)));
    const actor = userId ? { kind: "user" as const, userId } : null;
    return {
      docsContents: [...everyCollection(center.collections).flatMap((c) => c.articles), ...center.uncollected].map((a) => a.slug).sort(),
      collections: center.collections.map((c) => [c.slug, ...c.collections.map((n) => n.slug)].join(">")),
      pages: pages.flatMap((page, i) => (page ? [slugs[i]!] : [])).sort(),
      search: (await searchDocs(project.id, "widget", 10, groups)).map((r) => r.slug).sort(),
      answers: [...new Set((await answerSections(project.id, "widget help", 10, groups, 2000))!.map((s) => s.slug))].sort(),
      ...(actor && {
        api: (await call(listArticles, { actor, projectId: project.id }, {})).articles.map((a) => a.slug).sort(),
      }),
    };
  }

  test("signed out, or signed up on the portal: only what's for everyone", async () => {
    const expected = { docsContents: everyone.sort(), collections: ["basics"], pages: everyone.sort(), search: everyone.sort(), answers: everyone.sort() };
    expect(await seen(null)).toEqual(expected);
    const stranger = await signUp("Stranger");
    expect(await seen(stranger)).toEqual({ ...expected, api: everyone.sort() });
  });

  test("signed in by the app with a group: that group's collections too, with the ones in them; other groups' never", async () => {
    const ada = await ssoReader(["enterprise"]);
    const sorted = [...enterprise].sort();
    expect(await seen(ada)).toEqual({
      docsContents: sorted,
      collections: ["basics", "enterprise>setup"],
      pages: sorted,
      search: sorted,
      answers: sorted,
      api: sorted,
    });
    // An API key acts for the team: getArticle finds them all; a user in no group gets a 404.
    const grace = await ssoReader([]);
    await expect(call(getArticle, { actor: { kind: "user", userId: grace.id }, projectId: project.id }, { slug: "saml" })).rejects.toMatchObject({ status: 404 });
    expect(await call(getArticle, { actor: { kind: "user", userId: ada.id }, projectId: project.id }, { slug: "saml" })).toMatchObject({ slug: "saml" });
  });

  test("the team sees everything", async () => {
    const all = ["contact", "getting-started", "new-editor", "rolling-out", "saml"];
    expect(await seen(owner)).toEqual({
      docsContents: all,
      collections: ["basics", "enterprise>setup", "beta"],
      pages: all,
      search: all,
      answers: all,
      api: all,
    });
  });

  test("a collection inside a restricted one needs both: one for beta inside Enterprise is for people in both", async () => {
    await call(updateCollection, as(), { slug: "setup", groups: ["beta"] });
    const both = await ssoReader(["enterprise", "beta"]);
    const enterpriseOnly = await ssoReader(["enterprise"]);
    expect((await seen(both)).pages).toContain("rolling-out");
    expect((await seen(enterpriseOnly)).pages).not.toContain("rolling-out");
  });

  test("however deep, every collection above counts: one three levels into Enterprise is for enterprise, and one for beta there needs both", async () => {
    await call(createCollection, as(), { name: "Keys", parent: "setup" });
    await call(createCollection, as(), { name: "Preview", parent: "setup", groups: ["beta"] });
    for (const [title, collection] of [
      ["Rotating keys", "keys"],
      ["Early access", "preview"],
    ] as const) {
      const body = `The ${title} widget.`;
      openai.setVector(articleChunkText(title, { heading: "", text: body }), [0.9, Math.sqrt(1 - 0.81)]);
      const { slug } = await call(createArticle, as(), { title, body, collection });
      await call(publishArticle, as(), { slug });
    }
    /** What `user` reads of the two, in every way (but the collections' names). */
    const deep = async (user: TestUser | null) =>
      Object.fromEntries(
        Object.entries(await seen(user))
          .filter(([way]) => way !== "collections")
          .map(([way, slugs]) => [way, slugs.filter((s) => s === "rotating-keys" || s === "early-access")]),
      );
    const every = (slugs: string[], api = true) => ({
      docsContents: slugs,
      pages: slugs,
      search: slugs,
      answers: slugs,
      ...(api && { api: slugs }),
    });
    expect(await deep(null)).toEqual(every([], false));
    expect(await deep(await ssoReader(["beta"]))).toEqual(every([]));
    expect(await deep(await ssoReader(["enterprise"]))).toEqual(every(["rotating-keys"]));
    expect(await deep(await ssoReader(["enterprise", "beta"]))).toEqual(every(["early-access", "rotating-keys"]));
    expect(await deep(owner)).toEqual(every(["early-access", "rotating-keys"]));

    // Nor for search engines and AI tools, and its .md isn't cached for others.
    actAs(null);
    const params = Promise.resolve({ project: project.slug });
    expect(await (await llms(new Request("http://x"), { params })).text()).not.toContain("rotating-keys");
    expect(await (await sitemap(new Request("http://x"), { params })).text()).not.toContain("rotating-keys");
    actAs(owner);
    const md = await markdown(new Request("http://x"), { params: Promise.resolve({ project: project.slug, slug: "rotating-keys" }) });
    expect(md.headers.get("cache-control")).toBe("private, no-store");
  });

  test("the Docs layout's tree: only what the reader may read, the page's branch open and the rest of it closed", async () => {
    await call(createCollection, as(), { name: "Keys", parent: "setup" });
    await call(createCollection, as(), { name: "Billing", parent: "enterprise" });
    for (const [title, collection] of [
      ["Rotating keys", "keys"],
      ["Invoices", "billing"],
    ] as const) {
      const body = `The ${title} widget.`;
      openai.setVector(articleChunkText(title, { heading: "", text: body }), [0.9, Math.sqrt(1 - 0.81)]);
      const { slug } = await call(createArticle, as(), { title, body, collection });
      await call(publishArticle, as(), { slug });
    }
    // "Rotating keys" is open: it's in Keys, in Setup, in Enterprise.
    const tree = async (user: TestUser | null) => {
      actAs(user);
      return docsTree(await docsContents(project.slug), null, "keys");
    };

    const outside = await tree(await ssoReader([]));
    expect(outside.collections.map((c) => c.slug)).toEqual(["basics"]);
    expect(outside.uncollected.map((a) => a.slug)).toEqual(["contact"]);

    const inside = await tree(await ssoReader(["enterprise"]));
    expect(inside.collections.map((c) => c.slug)).toEqual(["basics", "enterprise"]);
    expect(inside.collections[1]).toMatchObject({
      open: true,
      articles: [{ slug: "saml" }],
      collections: [
        { slug: "setup", open: true, articles: [{ slug: "rolling-out" }], collections: [{ slug: "keys", open: true, articles: [{ slug: "rotating-keys" }] }] },
        { slug: "billing", open: false, articles: [{ slug: "invoices" }] },
      ],
    });
  });
});

test("a group's claim changed: its collections are for whoever the app signs in with the new one", async () => {
  await docsWithGroups();
  const before = await ssoReader(["enterprise"]);
  const after = await ssoReader(["plan:enterprise"]);
  const reads = async (user: TestUser) => {
    actAs(user);
    return (await publishedArticle(project.slug, "saml")) !== null;
  };
  expect([await reads(before), await reads(after)]).toEqual([true, false]);
  await call(updateGroup, as(), { group: "enterprise", claim: "plan:enterprise" });
  expect([await reads(before), await reads(after)]).toEqual([false, true]);
  const groups = await groupsOf(project.id, after.id);
  expect((await searchDocs(project.id, "widget", 10, groups)).map((r) => r.slug)).toContain("saml");
  expect((await searchDocs(project.id, "widget", 10, await groupsOf(project.id, before.id))).map((r) => r.slug)).not.toContain("saml");
});

test("each sign-in says the groups: a later token without one takes it away", async () => {
  await docsWithGroups();
  const sub = "user-42";
  const reader = await ssoReader([], sub);
  expect(await signIn({ groups: ["enterprise", "Enterprise"] }, sub)).toBe(reader.id);
  expect(await groupsOf(project.id, reader.id)).toEqual(["enterprise"]);
  actAs(reader);
  expect(await publishedArticle(project.slug, "saml")).toMatchObject({ title: "SAML" });
  await signIn({}, sub);
  expect(await groupsOf(project.id, reader.id)).toEqual([]);
  expect(await publishedArticle(project.slug, "saml")).toBeNull();
  // A new person's first sign-in keeps them too; bad group names are refused like any bad claim.
  expect(await groupsOf(project.id, await signIn({ groups: ["beta"] }))).toEqual(["beta"]);
  await expect(signIn({ groups: ["no spaces"] })).rejects.toThrow("invalid_claims");
});

describe("groups from conditions", () => {
  /** Docs as above, with Enterprise for whoever's on the enterprise plan (or, by claim, in "enterprise"). */
  beforeEach(async () => {
    await docsWithGroups();
    await call(updateGroup, as(), { group: "enterprise", conditions: [{ attribute: "plan", op: "is_one_of", value: ["enterprise", "custom"] }] });
  });
  /** Whether they read the SAML article (in Enterprise): its page, and in search. */
  const reads = async (user: TestUser) => {
    actAs(user);
    const page = await publishedArticle(project.slug, "saml");
    return { page: page !== null, search: (await searchDocs(project.id, "widget", 10, await groupsOf(project.id, user.id))).some((r) => r.slug === "saml") };
  };
  const yes = { page: true, search: true };
  const no = { page: false, search: false };
  /** Someone (with a session) the project's app signed in with `claims`. */
  const signedIn = async (claims: Record<string, unknown>, sub = `user-${randomUUID()}`) => {
    const reader = await ssoReader([], sub);
    await signIn(claims, sub);
    return reader;
  };

  test("readers whose attributes match read its collections; a later sign-in without them doesn't", async () => {
    const sub = "user-7";
    const reader = await signedIn({ attributes: { plan: "custom", seats: 40 } }, sub);
    expect(await groupsOf(project.id, reader.id)).toEqual(["enterprise"]);
    expect(await reads(reader)).toEqual(yes);
    await signIn({ attributes: { plan: "pro" } }, sub);
    expect(await groupsOf(project.id, reader.id)).toEqual([]);
    expect(await reads(reader)).toEqual(no);
    await signIn({ attributes: { plan: "enterprise" } }, sub);
    expect(await reads(reader)).toEqual(yes);
    // Left out of the token: gone too.
    await signIn({}, sub);
    expect(await reads(reader)).toEqual(no);
  });

  test("its claim or its conditions: either lets them in", async () => {
    expect(await reads(await signedIn({ groups: ["enterprise"], attributes: { plan: "free" } }))).toEqual(yes);
    expect(await reads(await signedIn({ attributes: { plan: "enterprise" } }))).toEqual(yes);
    expect(await reads(await signedIn({ groups: ["beta"], attributes: { plan: "Enterprise", enterprise: true } }))).toEqual(no);
    // Without its claim, only the conditions do.
    await call(updateGroup, as(), { group: "enterprise", claim: null });
    expect(await reads(await signedIn({ groups: ["enterprise"] }))).toEqual(no);
  });

  test("only people the project's SSO signs in: not others, even for a group of everyone without an attribute", async () => {
    await call(updateGroup, as(), { group: "enterprise", claim: null, conditions: [{ attribute: "plan", op: "is_not", value: "free" }] });
    expect(await reads(await signedIn({}))).toEqual(yes);
    expect(await reads(await signedIn({ attributes: { plan: "free" } }))).toEqual(no);
    expect(await reads(await signUp("Stranger"))).toEqual(no);
    actAs(null);
    expect(await publishedArticle(project.slug, "saml")).toBeNull();
    // Another project's SSO users neither.
    const other = await createProject(owner);
    const elsewhere = await signUp("Elsewhere");
    await prisma.ssoIdentity.create({ data: { projectId: other.id, externalId: "user-1", userId: elsewhere.id, attributes: { plan: "pro" } } });
    expect(await groupsOf(project.id, elsewhere.id)).toEqual([]);
  });
});

test("a first sign-in that loses the race to create the person still sets their groups", async () => {
  await addGroups("enterprise");
  for (let i = 0; i < 10; i++) {
    const externalId = `user-${randomUUID()}`;
    // An API call on their behalf (no groups) and their first sign-in, at the same time.
    const [, userId] = await Promise.all([
      upsertProjectUser(project.id, externalId, { name: "From the API" }),
      upsertProjectUser(project.id, externalId, { groups: ["enterprise"] }),
    ]);
    expect(await groupsOf(project.id, userId)).toEqual(["enterprise"]);
  }
});

test("search engines and AI tools only get what's for everyone; a restricted article's .md is never cached for others", async () => {
  await docsWithGroups();
  const params = Promise.resolve({ project: project.slug });
  const text = await (await llms(new Request("http://x"), { params })).text();
  expect(text).toContain("getting-started.md");
  expect(text).not.toContain("saml");
  expect(text).not.toContain("Enterprise");
  const map = await (await sitemap(new Request("http://x"), { params })).text();
  expect(map).toContain("/docs/getting-started");
  expect(map).not.toContain("/docs/saml");

  actAs(owner);
  const md = (slug: string) => markdown(new Request("http://x"), { params: Promise.resolve({ project: project.slug, slug }) });
  expect((await md("saml")).headers.get("cache-control")).toBe("private, no-store");
  // Not in shared caches either: a collection restricted later mustn't stay readable from one.
  expect((await md("getting-started")).headers.get("cache-control")).toBe("private, max-age=300");
  actAs(null);
  expect((await md("saml")).status).toBe(404);
});

test("collections take groups by key, with or without a claim", async () => {
  await call(createGroup, as(), { name: "Pro customers", conditions: [{ attribute: "plan", op: "is", value: "pro" }] });
  await call(createGroup, as(), { name: "Partners", claim: "partner" });
  expect(await call(createCollection, as(), { name: "Pro", groups: ["pro-customers", "partners"] })).toMatchObject({ groups: ["partners", "pro-customers"] });
  // Claims aren't keys.
  await expect(call(createCollection, as(), { name: "Partner", groups: ["partner"] })).rejects.toMatchObject({ status: 400 });
  // A group's key stays when its claim changes, and so do its collections.
  await call(updateGroup, as(), { group: "partners", claim: "partner-2" });
  expect((await call(listCollections, as(), {})).collections).toMatchObject([{ slug: "pro", groups: ["partners", "pro-customers"] }]);
});

test("collections take groups by key (lowercase, once each, only the project's) and say them", async () => {
  await addGroups("partners", "plan:pro");
  expect(await call(createCollection, as(), { name: "Partners", groups: ["Partners", "partners", "plan:pro"] })).toMatchObject({
    groups: ["partners", "plan:pro"],
  });
  await expect(call(createCollection, as(), { name: "Bad", groups: ["no spaces"] })).rejects.toMatchObject({ status: 400 });
  // A group the project doesn't have (another project's included) is refused, and nothing changes.
  const other = await createProject(owner);
  await prisma.readerGroup.create({ data: { projectId: other.id, key: "elsewhere", name: "Elsewhere", claim: "elsewhere" } });
  await expect(call(createCollection, as(), { name: "Elsewhere", groups: ["elsewhere"] })).rejects.toMatchObject({
    status: 400,
    message: "There's no group “elsewhere”: add it in Settings → Groups first",
  });
  await expect(call(updateCollection, as(), { slug: "partners", groups: ["partners", "elsewhere"] })).rejects.toMatchObject({ status: 400 });
  expect((await call(listCollections, as(), {})).collections).toMatchObject([{ slug: "partners", groups: ["partners", "plan:pro"] }]);
  expect(await call(updateCollection, as(), { slug: "partners", groups: [] })).toMatchObject({ groups: [] });
  expect((await call(listCollections, as(), {})).collections).toMatchObject([{ slug: "partners", groups: [] }]);
});
