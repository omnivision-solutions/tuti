import { readFileSync } from "node:fs";

import { prisma, type ReadAccess } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { WidgetDocs } from "@/components/widget-docs";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { docsContents, docsHome, docsPage, everyCollection, movedArticle, publishedArticle } from "./docs-queries";
import { answerArticle, countArticleView } from "./docs-readers";
import { answerSections, searchDocs } from "./docs-search";
import {
  createArticle,
  createCollection,
  createTab,
  deleteArticle,
  deleteTab,
  getArticle,
  listArticles,
  listCollections,
  listTabs,
  publishArticle,
  reorderTab,
  updateArticle,
  updateCollection,
  updateTab,
} from "./operations/docs";
import { answerQuestion } from "./operations/docs-ask";
import { deleteGroup } from "./operations/groups";
import { call } from "./operations/run";
import { readerOf } from "./portal-access";

/**
 * "Who can read" on tabs, collections and articles (lib/read-access.ts): inherit, signed-in
 * readers or groups, every level from the tab down to the page together. Whoever a page isn't for
 * doesn't see it anywhere; the team sees everything.
 */

let openai: OpenAIFake;
let model: ModelFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

const QUESTION = "widget help";
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

beforeAll(async () => {
  [openai, model] = await Promise.all([startOpenAIFake(), startModelFake()]);
  openai.setVector(QUESTION, along(1));
});
afterAll(() => Promise.all([openai.close(), model.close()]));
beforeEach(async () => {
  for (const [name, value] of Object.entries({ ...model.env, OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url })) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.done();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

test("the migration makes collections with groups “groups”, keeping them, and everything else inherit", async () => {
  const project = await createProject(owner);
  const sql = readFileSync(new URL("../../../../packages/db/prisma/migrations/20261021160000_read_access/migration.sql", import.meta.url), "utf8");
  // Back to before it (this file's database is its own).
  await prisma.$executeRawUnsafe(`
    DROP TABLE "tab_group";
    DROP TABLE "article_group";
    ALTER TABLE "docs_tab" DROP COLUMN "access";
    ALTER TABLE "collection" DROP COLUMN "access";
    ALTER TABLE "article" DROP COLUMN "access";
    DROP TYPE "ReadAccess";`);
  await prisma.$executeRaw`INSERT INTO docs_tab (id, "projectId", slug, name, "updatedAt") VALUES ('t1', ${project.id}, 'guides', 'Guides', now())`;
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, claim, "updatedAt") VALUES ('g1', ${project.id}, 'enterprise', 'Enterprise', 'enterprise', now())`;
  await prisma.$executeRaw`INSERT INTO collection (id, "projectId", "tabId", slug, name, "updatedAt") VALUES ('c1', ${project.id}, 't1', 'basics', 'Basics', now()), ('c2', ${project.id}, 't1', 'saml', 'SAML', now())`;
  await prisma.$executeRaw`INSERT INTO collection_group ("collectionId", "groupId") VALUES ('c2', 'g1')`;
  await prisma.$executeRaw`INSERT INTO article (id, "projectId", "collectionId", slug, title, "updatedAt") VALUES ('a1', ${project.id}, 'c2', 'setup', 'Setup', now())`;

  await prisma.$executeRawUnsafe(sql);

  const levels = { access: true, groups: { select: { group: { select: { key: true } } } } } as const;
  expect(await prisma.collection.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" }, select: { slug: true, ...levels } })).toEqual([
    { slug: "basics", access: "INHERIT", groups: [] },
    { slug: "saml", access: "GROUPS", groups: [{ group: { key: "enterprise" } }] },
  ]);
  expect(await prisma.docsTab.findMany({ where: { projectId: project.id }, select: levels })).toEqual([{ access: "INHERIT", groups: [] }]);
  expect(await prisma.article.findMany({ where: { projectId: project.id }, select: levels })).toEqual([{ access: "INHERIT", groups: [] }]);
});

/** Someone the project's SSO signed in, in `groups` (by claim), with a session for actAs. */
async function ssoReader(groups: string[]) {
  const user = await signUp("From the app");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: `user-${user.id}`, userId: user.id, groups } });
  return user;
}

/** Sets "Who can read" on a tab, collection or article, as the operations would. */
async function restrict(kind: "tab" | "collection" | "article", slug: string, access: ReadAccess, groups: string[] = []) {
  const links = (await prisma.readerGroup.findMany({ where: { projectId: project.id, key: { in: groups } }, select: { id: true } })).map((g) => ({ groupId: g.id }));
  const data = { access, groups: { deleteMany: {}, create: links } };
  const where = { projectId: project.id, slug };
  if (kind === "tab") {
    await prisma.docsTab.update({ where: { projectId_slug: where }, data });
  } else if (kind === "collection") {
    await prisma.collection.update({ where: { projectId_slug: where }, data });
  } else {
    const { id } = await prisma.article.findFirstOrThrow({ where: { ...where, deletedAt: null }, select: { id: true } });
    await prisma.article.update({ where: { id }, data });
  }
}

const ALL = ["contact", "endpoints", "getting-started"];

/**
 * Two tabs: Guides (first: Basics with "Getting started", and "Contact" in no collection) and API
 * (Reference with "Endpoints"). Every article says "widget", with a section close to QUESTION.
 */
beforeEach(async () => {
  await prisma.readerGroup.createMany({
    data: ["enterprise", "beta"].map((key) => ({ projectId: project.id, key, name: key[0]!.toUpperCase() + key.slice(1), claim: key })),
  });
  await call(createTab, as(), { name: "Guides" });
  await call(createTab, as(), { name: "API" });
  await call(createCollection, as(), { name: "Basics", tab: "guides" });
  await call(createCollection, as(), { name: "Reference", tab: "api" });
  for (const [title, collection] of [
    ["Getting started", "basics"],
    ["Endpoints", "reference"],
    ["Contact", null],
  ] as const) {
    const body = `The ${title} widget.`;
    openai.setVector(articleChunkText(title, { heading: "", text: body }), along(0.9));
    const { slug } = await call(createArticle, as(), { title, body, collection });
    await call(publishArticle, as(), { slug });
  }
});

const params = (slug?: string) => ({ params: Promise.resolve({ project: project.slug, ...(slug && { slug }) }) });
/** The strings in a server component's output (without rendering the components in it). */
const texts = (node: ReactNode): string[] =>
  Array.isArray(node)
    ? node.flatMap(texts)
    : typeof node === "string"
      ? [node]
      : isValidElement<{ children?: ReactNode; title?: unknown }>(node)
        ? [...(typeof node.props.title === "string" ? [node.props.title] : []), ...texts(node.props.children)]
        : [];

/** Whether the widget's panel opens article `slug` for whoever actAs set. */
async function widgetOpens(slug: string) {
  const widget = (await WidgetDocs({ projectId: project.id, projectSlug: project.slug, query: "", article: slug, hasBoard: true })) as ReactElement<object>;
  const view = await (widget.type as (props: object) => Promise<ReactNode>)(widget.props);
  return !texts(view).includes("Article not found");
}

/** The articles `user` (null: signed out) reads, every way readers read the docs. */
async function seen(user: TestUser | null) {
  actAs(user);
  const reader = await readerOf(project.id, user?.id);
  const docs = await docsContents(project.slug);
  const which = async (reads: (slug: string) => Promise<boolean>) => {
    const results = await Promise.all(ALL.map(async (slug) => [slug, await reads(slug)] as const));
    return results.filter(([, yes]) => yes).map(([slug]) => slug);
  };
  const actor = user && { actor: { kind: "user" as const, userId: user.id }, projectId: project.id };
  return {
    lists: [...everyCollection(docs.collections).flatMap((c) => c.articles), ...docs.uncollected].map((a) => a.slug).sort(),
    pages: await which(async (slug) => (await publishedArticle(project.slug, slug)) !== null),
    md: await which(async (slug) => (await markdown(new Request("http://x"), params(slug) as never)).status === 200),
    search: (await searchDocs(project.id, "widget", 10, reader)).map((r) => r.slug).sort(),
    answers: [...new Set((await answerSections(project.id, QUESTION, 10, reader, 2000))!.map((s) => s.slug))].sort(),
    widget: await which(widgetOpens),
    feedback: await which(async (slug) => !(await answerArticle(project.slug, slug, true)).error),
    ...(actor && {
      list: (await call(listArticles, actor, {})).articles.map((a) => a.slug).sort(),
      get: await which((slug) => call(getArticle, actor, { slug }).then(() => true, () => false)),
    }),
  };
}

/** `slugs` read every way (and through the API, for someone signed in). */
const everyWay = (slugs: string[], signedIn = true) => ({
  lists: slugs,
  pages: slugs,
  md: slugs,
  search: slugs,
  answers: slugs,
  widget: slugs,
  feedback: slugs,
  ...(signedIn && { list: slugs, get: slugs }),
});

describe("each level restricts what's under it", () => {
  test("a tab for signed-in readers: hidden from people signed out, there for anyone signed in", async () => {
    await restrict("tab", "api", "SIGNED_IN");
    expect(await seen(null)).toEqual(everyWay(["contact", "getting-started"], false));
    expect(await seen(await signUp("Stranger"))).toEqual(everyWay(ALL));
    expect(await seen(await ssoReader([]))).toEqual(everyWay(ALL));
    expect(await seen(owner)).toEqual(everyWay(ALL));
    // Its tab and collection pages too.
    actAs(null);
    expect(await docsPage(project.slug, "api")).toBeNull();
    expect(await docsPage(project.slug, "reference")).toBeNull();
    expect((await docsContents(project.slug)).tabs.map((t) => t.slug)).toEqual(["guides"]);
    actAs(await signUp("Stranger"));
    expect(await docsPage(project.slug, "api")).toMatchObject({ kind: "tab" });
    expect(await docsPage(project.slug, "reference")).toMatchObject({ kind: "collection" });
  });

  test("the first tab for signed-in readers takes the articles in no collection with it", async () => {
    await restrict("tab", "guides", "SIGNED_IN");
    expect(await seen(null)).toEqual(everyWay(["endpoints"], false));
    expect(await seen(await signUp("Stranger"))).toEqual(everyWay(ALL));
  });

  test("a collection for a group: only readers in it (and the team)", async () => {
    await restrict("collection", "basics", "GROUPS", ["enterprise"]);
    const others = everyWay(["contact", "endpoints"]);
    expect(await seen(await signUp("Stranger"))).toEqual(others);
    expect(await seen(await ssoReader(["beta"]))).toEqual(others);
    expect(await seen(await ssoReader(["enterprise"]))).toEqual(everyWay(ALL));
    expect(await seen(owner)).toEqual(everyWay(ALL));
  });

  test("an article for a group, in a collection for everyone", async () => {
    await restrict("article", "endpoints", "GROUPS", ["enterprise"]);
    expect(await seen(null)).toEqual(everyWay(["contact", "getting-started"], false));
    expect(await seen(await ssoReader(["beta"]))).toEqual(everyWay(["contact", "getting-started"]));
    expect(await seen(await ssoReader(["enterprise"]))).toEqual(everyWay(ALL));
    // Its collection, with nothing else in it, is gone for the rest too.
    actAs(null);
    expect(await docsPage(project.slug, "reference")).toBeNull();
  });

  test("an article in no collection for signed-in readers", async () => {
    await restrict("article", "contact", "SIGNED_IN");
    expect(await seen(null)).toEqual(everyWay(["endpoints", "getting-started"], false));
    expect(await seen(await signUp("Stranger"))).toEqual(everyWay(ALL));
  });

  test("a child can't widen what's above it: inherit, or signed-in readers, under a collection for a group stays for the group", async () => {
    await restrict("collection", "basics", "GROUPS", ["enterprise"]);
    await restrict("article", "getting-started", "SIGNED_IN");
    await call(createCollection, as(), { name: "Inside", parent: "basics" });
    await prisma.article.updateMany({ where: { projectId: project.id, slug: "contact" }, data: { collectionId: (await prisma.collection.findFirstOrThrow({ where: { slug: "inside" } })).id } });
    expect(await seen(await signUp("Stranger"))).toEqual(everyWay(["endpoints"]));
    expect(await seen(await ssoReader(["enterprise"]))).toEqual(everyWay(ALL));
    // And a tab for signed-in readers keeps a collection for everyone in it from people signed out.
    await restrict("tab", "api", "SIGNED_IN");
    await restrict("collection", "reference", "INHERIT");
    expect((await seen(null)).pages).toEqual([]);
  });

  test("groups with none picked: only the team", async () => {
    await restrict("collection", "reference", "GROUPS");
    for (const user of [null, await signUp("Stranger"), await ssoReader(["enterprise", "beta"])]) {
      expect((await seen(user)).pages).toEqual(["contact", "getting-started"]);
    }
    expect((await seen(owner)).pages).toEqual(ALL);
  });
});

test("search engines and AI tools get only what's for everyone, and restricted .md files aren't cached for others", async () => {
  await restrict("tab", "api", "SIGNED_IN");
  await restrict("article", "contact", "GROUPS", ["enterprise"]);
  const map = await (await sitemap(new Request("http://x"), params() as never)).text();
  const text = await (await llms(new Request("http://x"), params() as never)).text();
  for (const listing of [map, text]) {
    expect(listing).toContain("/docs/getting-started");
    expect(listing).toContain("/docs/basics");
    for (const hidden of ["/docs/endpoints", "/docs/reference", "/docs/api", "/docs/contact"]) {
      expect(listing).not.toContain(hidden);
    }
  }
  actAs(owner);
  const md = async (slug: string) => (await markdown(new Request("http://x"), params(slug) as never)).headers.get("cache-control");
  expect([await md("endpoints"), await md("contact"), await md("getting-started")]).toEqual(["private, no-store", "private, no-store", "private, max-age=300"]);
});

test("views count only for readers the article is for", async () => {
  await restrict("article", "endpoints", "SIGNED_IN");
  const views = async () => (await prisma.articleViewDay.aggregate({ where: { article: { slug: "endpoints" } }, _sum: { views: true } }))._sum.views ?? 0;
  await countArticleView(project.slug, "endpoints");
  expect(await views()).toBe(0);
  actAs(await signUp("Stranger"));
  await countArticleView(project.slug, "endpoints");
  expect(await views()).toBe(1);
});

test("a tab's landing page or card a reader may not read isn't shown to them: they get the overview without it", async () => {
  await call(updateTab, as(), { slug: "guides", landing: "page", landingPage: "getting-started" });
  await call(updateTab, as(), { slug: "api", landing: "page", landingPage: "reference" });
  await restrict("article", "getting-started", "SIGNED_IN");
  await restrict("collection", "reference", "GROUPS", ["enterprise"]);
  await call(createCollection, as(), { name: "More", tab: "api" });
  const more = await call(createArticle, as(), { title: "Changelog notes", collection: "more" });
  await call(publishArticle, as(), { slug: more.slug });
  const shown = async () => {
    const home = await docsHome(project.slug);
    const api = await docsPage(project.slug, "api");
    return {
      home: home.landing.kind,
      api: api?.kind === "tab" ? api.landing.kind : null,
      apiCards: api?.kind === "tab" ? api.tab.collections.map((c) => c.slug) : null,
    };
  };
  expect(await shown()).toEqual({ home: "overview", api: "overview", apiCards: ["more"] });
  actAs(await signUp("Stranger"));
  expect(await shown()).toEqual({ home: "article", api: "overview", apiCards: ["more"] });
  actAs(await ssoReader(["enterprise"]));
  expect(await shown()).toEqual({ home: "article", api: "collection", apiCards: ["reference", "more"] });
});

test("an old slug redirects only readers the page is for", async () => {
  await restrict("tab", "api", "SIGNED_IN");
  await call(updateCollection, as(), { slug: "reference", name: "API reference" });
  const endpoints = await prisma.article.findFirstOrThrow({ where: { slug: "endpoints" }, select: { id: true } });
  await prisma.docsRedirect.create({ data: { projectId: project.id, slug: "old-endpoints", articleId: endpoints.id } });
  expect(await docsPage(project.slug, "reference")).toBeNull();
  expect(await docsPage(project.slug, "old-endpoints")).toBeNull();
  expect(await movedArticle(project.slug, "old-endpoints")).toBeNull();
  actAs(await signUp("Stranger"));
  expect(await docsPage(project.slug, "reference")).toEqual({ kind: "redirect", path: "/docs/api-reference" });
  expect(await docsPage(project.slug, "old-endpoints")).toEqual({ kind: "redirect", path: "/docs/endpoints" });
});

test("AI answers recheck their sources: one restricted while the model writes isn't shown", async () => {
  const reader = { signedIn: true, groups: [] };
  const sections = (await answerSections(project.id, QUESTION, 10, reader, 2000))!;
  const reply = JSON.stringify({ answer: "Use the widget.", sources: sections.map((_, i) => `s${i + 1}`) });
  model.reply(reply, () => restrict("collection", "basics", "SIGNED_IN"));
  expect(await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", reader)).toMatchObject({ status: "answered" });
  model.reply(reply, () => restrict("collection", "basics", "GROUPS", ["enterprise"]));
  expect(await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", reader)).toMatchObject({ status: "no_answer", sources: [] });
  expect(await prisma.docsQuestion.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" }, select: { cause: true } })).toEqual({
    cause: "SOURCE_UNPUBLISHED",
  });
});

describe("the operations: access on tabs.*, collections.* and articles.*", () => {
  test("each takes access and groups, and says them", async () => {
    expect(await call(createTab, as(), { name: "Partners", access: "groups", groups: ["enterprise", "Beta", "beta"] })).toMatchObject({
      access: "groups",
      groups: ["beta", "enterprise"],
    });
    expect(await call(updateTab, as(), { slug: "api", access: "signed_in" })).toMatchObject({ slug: "api", name: "API", access: "signed_in", groups: [] });
    expect((await call(listTabs, as(), {})).tabs.map((t) => [t.slug, t.access, t.groups])).toEqual([
      ["guides", "inherit", []],
      ["api", "signed_in", []],
      ["partners", "groups", ["beta", "enterprise"]],
    ]);

    expect(await call(createCollection, as(), { name: "Pro", access: "signed_in" })).toMatchObject({ access: "signed_in", groups: [] });
    expect(await call(updateCollection, as(), { slug: "pro", access: "groups", groups: ["enterprise"] })).toMatchObject({ access: "groups", groups: ["enterprise"] });
    expect((await call(listCollections, as(), {})).collections.find((c) => c.slug === "pro")).toMatchObject({ access: "groups", groups: ["enterprise"] });

    expect(await call(createArticle, as(), { title: "Partner pricing", access: "groups", groups: ["beta"] })).toMatchObject({ access: "groups", groups: ["beta"] });
    expect(await call(updateArticle, as(), { slug: "endpoints", access: "signed_in" })).toMatchObject({ access: "signed_in", groups: [] });
    expect(await call(getArticle, as(), { slug: "endpoints" })).toMatchObject({ access: "signed_in", groups: [] });
    expect((await call(listArticles, as(), {})).articles.find((a) => a.slug === "endpoints")).toMatchObject({ access: "signed_in" });
    // A published article's access changes at once, like its listing: readers don't wait for a publish.
    expect(await publishedArticle(project.slug, "endpoints")).toBeNull();
    // Readers it's for don't get who else may read it.
    const reader = { actor: { kind: "user" as const, userId: (await signUp("Stranger")).id }, projectId: project.id };
    expect(await call(getArticle, reader, { slug: "endpoints" })).not.toHaveProperty("access");
  });

  test("groups alone, as collections' groups did: some make it “groups”, none “inherit”", async () => {
    expect(await call(createCollection, as(), { name: "Enterprise", groups: ["enterprise"] })).toMatchObject({ access: "groups", groups: ["enterprise"] });
    expect(await call(createCollection, as(), { name: "Open", groups: [] })).toMatchObject({ access: "inherit", groups: [] });
    expect(await call(updateCollection, as(), { slug: "enterprise", groups: [] })).toMatchObject({ access: "inherit", groups: [] });
    expect(await call(updateCollection, as(), { slug: "enterprise", groups: ["beta"] })).toMatchObject({ access: "groups", groups: ["beta"] });
    // Neither: unchanged.
    expect(await call(updateCollection, as(), { slug: "enterprise", name: "Enterprise plan" })).toMatchObject({ access: "groups", groups: ["beta"] });
  });

  test("“groups” without groups keeps the ones it has; another access drops them, so going back is only the team", async () => {
    await call(updateCollection, as(), { slug: "basics", access: "groups", groups: ["enterprise"] });
    expect(await call(updateCollection, as(), { slug: "basics", access: "groups" })).toMatchObject({ access: "groups", groups: ["enterprise"] });
    expect(await call(updateCollection, as(), { slug: "basics", access: "signed_in" })).toMatchObject({ access: "signed_in", groups: [] });
    expect(await call(updateCollection, as(), { slug: "basics", access: "groups" })).toMatchObject({ access: "groups", groups: [] });
  });

  test("unknown groups, or groups with another access, are refused and change nothing", async () => {
    await expect(call(updateTab, as(), { slug: "api", access: "groups", groups: ["nobody"] })).rejects.toMatchObject({
      status: 400,
      message: "There's no group “nobody”: add it in Settings → Groups first",
    });
    await expect(call(updateArticle, as(), { slug: "endpoints", access: "signed_in", groups: ["beta"] })).rejects.toMatchObject({
      status: 400,
      message: "Groups go with access “groups”",
    });
    await expect(call(createCollection, as(), { name: "Bad", access: "everyone" as never })).rejects.toMatchObject({ status: 400 });
    expect((await call(listTabs, as(), {})).tabs.map((t) => t.access)).toEqual(["inherit", "inherit"]);
    expect(await call(getArticle, as(), { slug: "endpoints" })).toMatchObject({ access: "inherit" });
  });

  test("a group a tab, collection or live article is for can't be deleted; a deleted article lets it go", async () => {
    await call(updateTab, as(), { slug: "api", access: "groups", groups: ["enterprise"] });
    await call(updateCollection, as(), { slug: "basics", access: "groups", groups: ["enterprise"] });
    await call(updateArticle, as(), { slug: "contact", access: "groups", groups: ["enterprise", "beta"] });
    await expect(call(deleteGroup, as(), { group: "enterprise" })).rejects.toMatchObject({
      status: 409,
      message: "Used by API, Basics and Contact; remove it from them first",
    });
    await call(deleteArticle, as(), { slug: "contact" });
    expect(await call(deleteGroup, as(), { group: "beta" })).toEqual({ deleted: "beta" });
  });
});

describe("a tab change never opens what the tab kept closed", () => {
  const accessOf = async (kind: "collection" | "article", slug: string) => {
    const select = { access: true, groups: { select: { group: { select: { key: true } } } } } as const;
    const row =
      kind === "collection"
        ? await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug }, select })
        : await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug }, select });
    return [row.access, ...row.groups.map((g) => g.group.key)];
  };

  test("deleting a restricted tab: its collections keep its access, for people signed out and outside the group", async () => {
    await restrict("tab", "api", "GROUPS", ["enterprise"]);
    await call(deleteTab, as(), { slug: "api" });
    expect(await accessOf("collection", "reference")).toEqual(["GROUPS", "enterprise"]);
    expect((await seen(null)).pages).toEqual(["contact", "getting-started"]);
    expect((await seen(await ssoReader(["beta"]))).pages).toEqual(["contact", "getting-started"]);
    expect((await seen(await ssoReader(["enterprise"]))).pages).toEqual(ALL);
  });

  test("deleting the last tab, restricted: its collections and the articles in none keep its access; a tab that inherits copies nothing", async () => {
    await call(deleteTab, as(), { slug: "api" });
    expect(await accessOf("collection", "reference")).toEqual(["INHERIT"]);
    await restrict("tab", "guides", "SIGNED_IN");
    await call(deleteTab, as(), { slug: "guides" });
    // Reference moved into Guides with the first delete, so it's one of its collections now.
    expect(await Promise.all([accessOf("collection", "basics"), accessOf("collection", "reference"), accessOf("article", "contact")])).toEqual([
      ["SIGNED_IN"],
      ["SIGNED_IN"],
      ["SIGNED_IN"],
    ]);
    expect((await seen(null)).pages).toEqual([]);
    expect((await seen(await signUp("Stranger"))).pages).toEqual(ALL);
  });

  test("reordering: when another tab becomes first, the articles in no collection keep the old first tab's access", async () => {
    await restrict("tab", "guides", "GROUPS", ["enterprise"]);
    await call(reorderTab, as(), { slug: "api", position: 0 });
    expect(await accessOf("article", "contact")).toEqual(["GROUPS", "enterprise"]);
    expect((await seen(null)).pages).toEqual(["endpoints"]);
    expect((await seen(await ssoReader(["beta"]))).pages).toEqual(["endpoints"]);
    expect((await seen(await ssoReader(["enterprise"]))).pages).toEqual(ALL);
  });
});
