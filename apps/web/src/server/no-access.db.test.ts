import { type NoAccess, prisma, type ReadAccess } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import DocsSlugPage, { generateMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { WidgetDocs } from "@/components/widget-docs";
import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { docsContents, docsHome, docsPage, everyCollection } from "./docs-queries";
import { answerSections, searchForReader } from "./docs-search";
import {
  createArticle,
  createCollection,
  createTab,
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
import { call } from "./operations/run";
import { currentReader } from "./portal-access";

/**
 * "People without access" (lib/read-access.ts `locks`): what someone a page isn't for sees of it.
 * Hidden (the default) is as before; shown with a lock, its title is listed with a lock and its page
 * has the title and what to do, never anything it says.
 */

let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

/** In every article's text and nowhere else: whatever has it shows some of the text. */
const SECRET = "zebra";
const QUESTION = "widget help";
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

beforeAll(async () => {
  openai = await startOpenAIFake();
  openai.setVector(QUESTION, along(1));
});
afterAll(() => openai.close());
afterEach(() => {
  vi.unstubAllEnvs();
  request.headers = {};
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/**
 * Two tabs: Guides (first: Basics with "Getting started", and "Contact" in no collection) and API
 * (Reference, "Every zebra endpoint", with "Endpoints"). Every article says "widget" and SECRET.
 */
beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(null);
  await prisma.readerGroup.create({ data: { projectId: project.id, key: "enterprise", name: "Enterprise", claim: "enterprise" } });
  await call(createTab, as(), { name: "Guides" });
  await call(createTab, as(), { name: "API" });
  await call(createCollection, as(), { name: "Basics", tab: "guides" });
  await call(createCollection, as(), { name: "Reference", tab: "api", description: `Every ${SECRET} endpoint` });
  for (const [title, collection] of [
    ["Getting started", "basics"],
    ["Endpoints", "reference"],
    ["Contact", null],
  ] as const) {
    const body = `The ${title} widget.\n\n## Keys\n\nRotate the ${SECRET} key.`;
    openai.setVector(articleChunkText(title, { heading: "", text: body }), along(0.9));
    const { slug } = await call(createArticle, as(), { title, body, collection });
    await call(publishArticle, as(), { slug });
  }
});

/** Sets "Who can read" and "People without access" on a tab, collection or article. */
async function set(kind: "tab" | "collection" | "article", slug: string, access: ReadAccess, noAccess: NoAccess = "INHERIT", groups: string[] = []) {
  const links = (await prisma.readerGroup.findMany({ where: { projectId: project.id, key: { in: groups } }, select: { id: true } })).map((g) => ({ groupId: g.id }));
  const data = { access, noAccess, groups: { deleteMany: {}, create: links } };
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

async function ssoReader(groups: string[]) {
  const user = await signUp("From the app");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: `user-${user.id}`, userId: user.id, groups } });
  return user;
}

const params = (slug?: string) => ({ params: Promise.resolve({ project: project.slug, ...(slug && { slug }) }) });

/**
 * A server component's output with the server components in it rendered too; a client component
 * (one that can't be called outside React: it uses hooks) stays as its name and props, which is
 * what the browser gets of it.
 */
async function rendered(node: ReactNode): Promise<unknown> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child: ReactNode) => rendered(child)));
  }
  if (!isValidElement(node)) {
    return node;
  }
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (typeof type === "function") {
    try {
      return await rendered(await (type as (props: object) => ReactNode | Promise<ReactNode>)(props));
    } catch {
      // A client component: its props.
    }
  }
  const children = await rendered(props.children as ReactNode);
  return { component: typeof type === "function" ? type.name : type, props: { ...props, children } };
}

/** As JSON, each object once (props can share, or loop back to, objects). */
function json(value: unknown) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) {
        return undefined;
      }
      seen.add(v);
    }
    return v;
  });
}

/** All a docs page sends this reader (actAs), and its metadata, as one string. */
async function pageText(slug: string) {
  const [page, metadata] = await Promise.all([DocsSlugPage(params(slug) as never), generateMetadata(params(slug) as never)]);
  return json([await rendered(page), metadata]);
}

/** What the widget shows of article `slug`, as one string. */
async function widgetText(slug: string) {
  return json(await rendered(await WidgetDocs({ projectId: project.id, projectSlug: project.slug, query: "", article: slug, hasBoard: true })));
}

/** Every article in the docs' lists for whoever's reading, with `locked` when it has a lock. */
async function listed() {
  const docs = await docsContents(project.slug);
  return [...everyCollection(docs.collections).flatMap((c) => c.articles), ...docs.uncollected].map((a) => (a.locked ? `${a.slug} (locked)` : a.slug)).sort();
}

describe("an article shown with a lock", () => {
  beforeEach(() => set("article", "endpoints", "SIGNED_IN", "LOCK"));

  test("people signed out see its title with a lock everywhere it's listed, and its page asks them to sign in, with nothing of its text", async () => {
    expect(await listed()).toEqual(["contact", "endpoints (locked)", "getting-started"]);
    // Only what the page may show: the title, the way back to its collection and tab, and who's reading.
    expect(await docsPage(project.slug, "endpoints")).toEqual({
      kind: "locked",
      article: { slug: "endpoints", title: "Endpoints", collection: { slug: "reference", name: "Reference" }, tab: "api", signedIn: false },
    });
    const page = await pageText("endpoints");
    expect(page).toContain("Endpoints");
    expect(page).toContain("Sign in to read this.");
    expect(page).toContain("SignInLink");
    expect(page).not.toContain("You don't have access to this.");
    for (const text of [SECRET, "widget", "Keys", "On this page"]) {
      expect(page).not.toContain(text);
    }
    expect(await generateMetadata(params("endpoints") as never)).toEqual({
      title: "Endpoints · Docs",
      robots: { index: false },
      alternates: { canonical: expect.stringMatching(/\/docs\/endpoints$/) },
    });
    // Its .md and AI answers stay closed.
    expect((await markdown(new Request("http://x"), params("endpoints") as never)).status).toBe(404);
    expect((await answerSections(project.id, QUESTION, 10, SIGNED_OUT, 2000))!.map((s) => s.slug)).not.toContain("endpoints");
    // The widget: the same, with its own way to sign in.
    const widget = await widgetText("endpoints");
    expect(widget).toContain("Endpoints");
    expect(widget).toContain("WidgetLocked");
    expect(widget).not.toContain(SECRET);
  });

  test("someone signed in it isn't for is told they don't have access", async () => {
    actAs(await signUp("Stranger"));
    await set("article", "endpoints", "GROUPS", "LOCK", ["enterprise"]);
    expect(await docsPage(project.slug, "endpoints")).toMatchObject({ kind: "locked", article: { signedIn: true } });
    const page = await pageText("endpoints");
    expect(page).toContain("You don't have access to this.");
    expect(page).not.toContain("Sign in to read this.");
    expect(page).not.toContain(SECRET);
    const widget = await widgetText("endpoints");
    expect(widget).toContain("You don't have access to this.");
    expect(widget).not.toContain(SECRET);
  });

  test("readers it's for, and the team, read it as before", async () => {
    actAs(await signUp("Stranger"));
    expect(await listed()).toEqual(["contact", "endpoints", "getting-started"]);
    expect(await pageText("endpoints")).toContain(SECRET);
    actAs(owner);
    expect(await pageText("endpoints")).toContain(SECRET);
  });

  test("search finds it by its title only, with no snippet; its text matches nothing", async () => {
    const search = (q: string) => searchForReader(project.id, project.slug, q, 10);
    expect(await search("endpoints")).toEqual([{ slug: "endpoints", title: "Endpoints", snippet: "", locked: true }]);
    // Words only in its text: the articles they may read, never this one.
    expect((await search(SECRET)).map((r) => r.slug).sort()).toEqual(["contact", "getting-started"]);
    expect((await search(QUESTION)).map((r) => r.slug)).not.toContain("endpoints");
    // Signed in, it's an ordinary result again.
    actAs(await signUp("Stranger"));
    expect(await search(SECRET)).toContainEqual(expect.objectContaining({ slug: "endpoints", snippet: expect.stringContaining(SECRET) }));
  });

  test("search engines and AI tools don't get it", async () => {
    const map = await (await sitemap(new Request("http://x"), params() as never)).text();
    const text = await (await llms(new Request("http://x"), params() as never)).text();
    for (const listing of [map, text]) {
      expect(listing).not.toContain("/docs/endpoints");
    }
  });
});

describe("hidden: as before", () => {
  test("by default, and when chosen under a lock: not listed, and its page is not found", async () => {
    await set("article", "endpoints", "SIGNED_IN");
    expect(await listed()).toEqual(["contact", "getting-started"]);
    expect(await docsPage(project.slug, "endpoints")).toBeNull();
    expect(await searchForReader(project.id, project.slug, "endpoints", 10)).toEqual([]);
    await set("collection", "reference", "INHERIT", "LOCK");
    await set("article", "endpoints", "SIGNED_IN", "HIDE");
    expect(await listed()).toEqual(["contact", "getting-started"]);
    expect(await docsPage(project.slug, "endpoints")).toBeNull();
    expect(await widgetText("endpoints")).toContain("Article not found");
  });
});

describe("inherited", () => {
  test("from the collection it's in, or its tab: the nearest one that says", async () => {
    await set("article", "endpoints", "SIGNED_IN");
    await set("collection", "reference", "INHERIT", "LOCK");
    expect(await listed()).toContain("endpoints (locked)");
    expect(await docsPage(project.slug, "endpoints")).toMatchObject({ kind: "locked" });
    await set("collection", "reference", "INHERIT");
    await set("tab", "api", "INHERIT", "LOCK");
    expect(await docsPage(project.slug, "endpoints")).toMatchObject({ kind: "locked" });
    await set("collection", "reference", "INHERIT", "HIDE");
    expect(await docsPage(project.slug, "endpoints")).toBeNull();
    // An article in no collection: the first tab's.
    await set("article", "contact", "SIGNED_IN");
    await set("tab", "guides", "INHERIT", "LOCK");
    expect(await listed()).toEqual(["contact (locked)", "getting-started"]);
  });
});

test("a collection shown with a lock: its name with a lock and nothing in it, and its page the message", async () => {
  await set("collection", "reference", "SIGNED_IN", "LOCK");
  const api = (await docsContents(project.slug)).tabs.find((t) => t.slug === "api");
  expect(api?.collections).toEqual([{ slug: "reference", name: "Reference", description: "", icon: null, articles: [], collections: [], locked: true }]);
  expect(await docsPage(project.slug, "reference")).toMatchObject({ kind: "collection", collection: { locked: true } });
  const page = await pageText("reference");
  expect(page).toContain("Sign in to read this.");
  expect(page).toContain("Reference");
  for (const text of [SECRET, "Endpoints"]) {
    expect(page).not.toContain(text);
  }
  expect(await generateMetadata(params("reference") as never)).toMatchObject({ title: "Reference · Docs", robots: { index: false } });
  // What's in it inherits the lock.
  expect(await docsPage(project.slug, "endpoints")).toMatchObject({ kind: "locked" });
});

test("a tab shown with a lock: listed with a lock, and its page the message", async () => {
  await set("tab", "api", "SIGNED_IN", "LOCK");
  const docs = await docsContents(project.slug);
  expect(docs.tabs.map((t) => [t.slug, t.locked ?? false, t.collections.length])).toEqual([
    ["guides", false, 1],
    ["api", true, 0],
  ]);
  expect(await docsPage(project.slug, "api")).toMatchObject({ kind: "tab", tab: { locked: true } });
  const page = await pageText("api");
  expect(page).toContain("Sign in to read this.");
  for (const text of [SECRET, "Endpoints"]) {
    expect(page).not.toContain(text);
  }
  expect(await generateMetadata(params("api") as never)).toMatchObject({ robots: { index: false } });
  // The first tab locked: /docs is its message.
  await set("tab", "guides", "SIGNED_IN", "LOCK");
  expect((await docsHome(project.slug)).tab).toMatchObject({ slug: "guides", locked: true });
  // Search engines get none of it.
  const map = await (await sitemap(new Request("http://x"), params() as never)).text();
  for (const path of ["/docs/api", "/docs/reference", "/docs/endpoints"]) {
    expect(map).not.toContain(path);
  }
});

describe("the operations: noAccess on tabs.*, collections.* and articles.*", () => {
  test("each takes it and says it, on its own or with access", async () => {
    expect(await call(createTab, as(), { name: "Partners", access: "signed_in", noAccess: "lock" })).toMatchObject({ access: "signed_in", noAccess: "lock" });
    expect(await call(updateTab, as(), { slug: "api", noAccess: "hide" })).toMatchObject({ access: "inherit", noAccess: "hide" });
    expect((await call(listTabs, as(), {})).tabs.map((t) => [t.slug, t.noAccess])).toEqual([
      ["guides", "inherit"],
      ["api", "hide"],
      ["partners", "lock"],
    ]);

    expect(await call(createCollection, as(), { name: "Pro", noAccess: "lock" })).toMatchObject({ access: "inherit", noAccess: "lock" });
    expect(await call(updateCollection, as(), { slug: "pro", access: "signed_in", noAccess: "hide" })).toMatchObject({ access: "signed_in", noAccess: "hide" });
    expect((await call(listCollections, as(), {})).collections.find((c) => c.slug === "pro")).toMatchObject({ noAccess: "hide" });

    expect(await call(createArticle, as(), { title: "Partner pricing", noAccess: "lock" })).toMatchObject({ access: "inherit", noAccess: "lock" });
    // Changed at once on a published article, keeping its access and groups.
    await call(updateArticle, as(), { slug: "endpoints", access: "groups", groups: ["enterprise"] });
    expect(await call(updateArticle, as(), { slug: "endpoints", noAccess: "lock" })).toMatchObject({ access: "groups", groups: ["enterprise"], noAccess: "lock" });
    expect(await call(getArticle, as(), { slug: "endpoints" })).toMatchObject({ noAccess: "lock" });
    expect((await call(listArticles, as(), {})).articles.find((a) => a.slug === "endpoints")).toMatchObject({ noAccess: "lock" });
    expect(await docsPage(project.slug, "endpoints")).toMatchObject({ kind: "locked" });

    await expect(call(updateArticle, as(), { slug: "endpoints", noAccess: "show" as never })).rejects.toMatchObject({ status: 400 });
  });

  test("deleting or reordering a tab copies what it shows the rest onto what it stops governing, as it does who can read", async () => {
    const noAccessOf = async (kind: "collection" | "article", slug: string) =>
      kind === "collection"
        ? (await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug }, select: { noAccess: true } })).noAccess
        : (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug }, select: { noAccess: true } })).noAccess;
    await set("tab", "api", "SIGNED_IN", "LOCK");
    await set("article", "endpoints", "INHERIT", "HIDE");
    await call(deleteTab, as(), { slug: "api" });
    expect(await noAccessOf("collection", "reference")).toBe("LOCK");
    // Its own choice stays.
    expect(await noAccessOf("article", "endpoints")).toBe("HIDE");
    await set("article", "endpoints", "INHERIT");
    expect(await docsPage(project.slug, "endpoints")).toMatchObject({ kind: "locked" });

    // A new first tab: the articles in no collection keep the old first tab's.
    await set("tab", "guides", "SIGNED_IN", "LOCK");
    await call(createTab, as(), { name: "More" });
    await call(reorderTab, as(), { slug: "more", position: 0 });
    expect(await noAccessOf("article", "contact")).toBe("LOCK");
    expect(await docsPage(project.slug, "contact")).toMatchObject({ kind: "locked" });
  });
});

describe("Preview as a reader (?preview=signed-out, passed on by proxy.ts)", () => {
  const previewing = () => (request.headers = { "x-tuti-preview": "signed-out" });

  beforeEach(async () => {
    await set("article", "endpoints", "SIGNED_IN", "LOCK");
    await set("article", "contact", "GROUPS", "INHERIT", ["enterprise"]);
  });

  test("shows the team the docs as people signed out see them", async () => {
    actAs(owner);
    previewing();
    expect(await currentReader(project.id)).toEqual(SIGNED_OUT);
    expect(await listed()).toEqual(["endpoints (locked)", "getting-started"]);
    expect(await docsPage(project.slug, "endpoints")).toMatchObject({ kind: "locked", article: { signedIn: false } });
    expect(await docsPage(project.slug, "contact")).toBeNull();
  });

  test("changes nothing for anyone else: never more than they may read", async () => {
    previewing();
    expect(await listed()).toEqual(["endpoints (locked)", "getting-started"]);
    expect(await docsPage(project.slug, "contact")).toBeNull();
    for (const user of [await signUp("Stranger"), await ssoReader(["enterprise"])]) {
      actAs(user);
      const reader = await currentReader(project.id);
      request.headers = {};
      expect(await currentReader(project.id)).toEqual(reader);
      previewing();
    }
    // The enterprise reader still reads what's for them, and no more than without it.
    expect(await listed()).toEqual(["contact", "endpoints", "getting-started"]);
  });
});
