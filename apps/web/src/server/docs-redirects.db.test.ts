import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, test } from "vitest";

import ArticlePage from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { WidgetDocs } from "@/components/widget-docs";
import { actAs, createProject, inGroupNamed, signUp, type TestUser } from "@/test/helpers";

import {
  createArticle,
  createCollection,
  createTab,
  deleteArticle,
  deleteTab,
  publishArticle,
  restoreArticle,
  unpublishArticle,
  updateArticle,
  updateCollection,
  updateTab,
} from "./operations/docs";
import { call } from "./operations/run";

/** Renamed pages redirect: a slug a tab, collection or article had sends readers to its current one. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(null);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** The project's redirects, as "old slug → the page's current slug". */
async function redirects() {
  const rows = await prisma.docsRedirect.findMany({
    where: { projectId: project.id },
    orderBy: { slug: "asc" },
    select: { slug: true, tab: { select: { slug: true } }, collection: { select: { slug: true } }, article: { select: { slug: true } } },
  });
  return rows.map((row) => {
    const [kind, page] = Object.entries({ tab: row.tab, collection: row.collection, article: row.article }).find(([, to]) => to)!;
    return `${row.slug} → ${kind} ${page!.slug}`;
  });
}

describe("renaming records where the page went", () => {
  test("a draft renamed twice: both old slugs point at the article, not at each other", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    await call(updateArticle, as(), { slug: "beta", title: "Gamma" });
    await call(publishArticle, as(), { slug: "gamma" });
    expect(await redirects()).toEqual(["alpha → article gamma", "beta → article gamma"]);
    // Saving with the same title (or one with the same slug) records nothing.
    await call(createArticle, as(), { title: "Delta" });
    await call(updateArticle, as(), { slug: "delta", title: "DELTA" });
    expect(await redirects()).toHaveLength(2);
  });

  test("tabs and collections too", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(updateTab, as(), { slug: "guides", name: "Handbook" });
    await call(createCollection, as(), { name: "Basics" });
    await call(updateCollection, as(), { slug: "basics", name: "Essentials" });
    // A change that keeps the name keeps the slug: no redirect to itself.
    await call(updateCollection, as(), { slug: "essentials", name: "Essentials", description: "Start here" });
    expect(await redirects()).toEqual(["basics → collection essentials", "guides → tab handbook"]);
  });

  test("a deleted article restored under another slug leaves a redirect behind its old one", async () => {
    await call(createArticle, as(), { title: "Billing" });
    await call(deleteArticle, as(), { slug: "billing" });
    await call(createCollection, as(), { name: "Billing" });
    expect(await call(restoreArticle, as(), { slug: "billing" })).toMatchObject({ slug: "billing-2" });
    expect(await redirects()).toEqual(["billing → article billing-2"]);
  });
});

describe("a page taking an old slug wins", () => {
  test("a new page takes it, and the redirect is gone", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    expect(await redirects()).toEqual(["alpha → article beta"]);
    expect(await call(createTab, as(), { name: "Alpha" })).toMatchObject({ slug: "alpha" });
    expect(await redirects()).toEqual([]);
  });

  test("another page renamed to it takes it", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(updateTab, as(), { slug: "guides", name: "Handbook" });
    await call(createCollection, as(), { name: "Basics" });
    expect(await call(updateCollection, as(), { slug: "basics", name: "Guides" })).toMatchObject({ slug: "guides" });
    expect(await redirects()).toEqual(["basics → collection guides"]);
  });

  test("renaming back to an old slug of its own drops that redirect", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    await call(updateArticle, as(), { slug: "beta", title: "Alpha" });
    expect(await redirects()).toEqual(["beta → article alpha"]);
  });

  test("a deleted article restored to its own slug, which a redirect had since, takes it", async () => {
    await call(createArticle, as(), { title: "Billing" });
    await call(deleteArticle, as(), { slug: "billing" });
    await call(createTab, as(), { name: "Billing" });
    await call(updateTab, as(), { slug: "billing", name: "Payments" });
    expect(await redirects()).toEqual(["billing → tab payments"]);
    expect(await call(restoreArticle, as(), { slug: "billing" })).toMatchObject({ slug: "billing" });
    expect(await redirects()).toEqual([]);
  });
});

describe("deleting a page drops its redirects", () => {
  test("an article, once it's purged; a tab", async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    await call(createTab, as(), { name: "Guides" });
    await call(updateTab, as(), { slug: "guides", name: "Handbook" });

    await call(deleteArticle, as(), { slug: "beta" });
    // Restorable for 30 days: its redirects stay until it's purged.
    expect(await redirects()).toEqual(["alpha → article beta", "guides → tab handbook"]);
    await prisma.article.updateMany({ where: { projectId: project.id }, data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
    await handlers.purgeArticles({}, { info: () => {}, warn: () => {} });
    expect(await redirects()).toEqual(["guides → tab handbook"]);

    await call(deleteTab, as(), { slug: "handbook" });
    expect(await redirects()).toEqual([]);
  });
});

/** What a reader gets at /docs/<slug>, its .md and the widget's article view: the page, a redirect or a 404. */
async function read(slug: string) {
  const params = { params: Promise.resolve({ project: project.slug, slug }) } as never;
  const page = await ArticlePage(params).then(
    () => "page",
    (error: { digest?: string }) => {
      const redirect = error.digest?.match(/^NEXT_REDIRECT;\w+;([^;]+);(\d+);/);
      return redirect ? `${redirect[2]} ${redirect[1]}` : error.digest === "NEXT_HTTP_ERROR_FALLBACK;404" ? "404" : Promise.reject(error);
    },
  );
  const response = await markdown(new Request("http://x"), params);
  const md = response.status === 308 ? `308 ${response.headers.get("location")}` : String(response.status);
  // WidgetDocs hands the article to WidgetArticle, rendered here: the article's title, or "Article not found".
  const widget = (await WidgetDocs({ projectId: project.id, projectSlug: project.slug, query: "", article: slug })) as ReactElement<object>;
  const texts = (node: ReactNode): string[] =>
    Array.isArray(node)
      ? node.flatMap(texts)
      : typeof node === "string"
        ? [node]
        : isValidElement<{ children?: ReactNode; title?: string }>(node)
          ? [...(node.props.title ? [node.props.title] : []), ...texts(node.props.children)]
          : [];
  const shown = texts(await (widget.type as (props: object) => Promise<ReactNode>)(widget.props));
  return { page, md, widget: shown.find((text) => ["Gamma", "Article not found"].includes(text)) };
}

const moved = { page: "308 /docs/gamma", md: "308 /docs/gamma.md", widget: "Gamma" };
const missing = { page: "404", md: "404", widget: "Article not found" };

describe("readers follow an article's old slugs", () => {
  beforeEach(async () => {
    await call(createArticle, as(), { title: "Alpha" });
    await call(updateArticle, as(), { slug: "alpha", title: "Beta" });
    await call(updateArticle, as(), { slug: "beta", title: "Gamma" });
  });

  test("permanently, to where it is now, once it's published", async () => {
    // A draft is served nowhere, by its old slugs neither.
    expect(await read("alpha")).toEqual(missing);
    await call(publishArticle, as(), { slug: "gamma" });
    expect(await read("alpha")).toEqual(moved);
    expect(await read("beta")).toEqual(moved);
    expect(await read("gamma")).toEqual({ page: "page", md: "200", widget: "Gamma" });
  });

  test("only while the reader may read it: hidden, unpublished, deleted or for other groups, it's a 404", async () => {
    await call(publishArticle, as(), { slug: "gamma" });
    await call(updateArticle, as(), { slug: "gamma", listing: "hidden" });
    expect(await read("alpha")).toEqual(missing);
    await call(updateArticle, as(), { slug: "gamma", listing: "unlisted" });
    expect(await read("alpha")).toEqual(moved);

    await prisma.readerGroup.create({ data: { projectId: project.id, key: "enterprise", name: "Enterprise", conditions: inGroupNamed("enterprise") } });
    await call(createCollection, as(), { name: "Enterprise", groups: ["enterprise"] });
    await call(updateArticle, as(), { slug: "gamma", collection: "enterprise", publish: true });
    expect(await read("alpha")).toEqual(missing);
    const member = await signUp("From the app");
    await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "user-1", userId: member.id, properties: { groups: ["enterprise"] } } });
    actAs(member);
    expect(await read("alpha")).toEqual(moved);
    actAs(null);
    await call(updateArticle, as(), { slug: "gamma", collection: null, publish: true });

    await call(unpublishArticle, as(), { slug: "gamma" });
    expect(await read("alpha")).toEqual(missing);
    await call(publishArticle, as(), { slug: "gamma" });
    await call(deleteArticle, as(), { slug: "gamma" });
    expect(await read("alpha")).toEqual(missing);
  });

  test("an article that takes an old slug is what readers get there", async () => {
    await call(publishArticle, as(), { slug: "gamma" });
    await call(createArticle, as(), { title: "Alpha" });
    await call(publishArticle, as(), { slug: "alpha" });
    expect((await read("alpha")).page).toBe("page");
    expect(await read("beta")).toEqual(moved);
  });

  test("a renamed tab's or collection's old slug goes to its page; .md and the widget's article view don't follow it", async () => {
    await call(publishArticle, as(), { slug: "gamma" });
    await call(createTab, as(), { name: "Guides" });
    await call(createTab, as(), { name: "API" });
    await call(createCollection, as(), { name: "Basics", tab: "api" });
    await call(updateArticle, as(), { slug: "gamma", collection: "basics", publish: true });
    await call(updateTab, as(), { slug: "api", name: "Handbook" });
    await call(updateCollection, as(), { slug: "basics", name: "Essentials" });
    expect(await read("api")).toEqual({ ...missing, page: "308 /docs/handbook" });
    expect(await read("basics")).toEqual({ ...missing, page: "308 /docs/essentials" });
  });
});
