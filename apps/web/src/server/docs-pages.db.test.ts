import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import DocsSlugPage, { generateMetadata as slugMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { generateMetadata as docsMetadata } from "@/app/portal/[project]/(site)/docs/page";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { docsPage } from "./docs-queries";
import { createArticle, createCollection, createTab, publishArticle, updateArticle, updateCollection, updateTab } from "./operations/docs";
import { call } from "./operations/run";

/** /docs/<slug>: a tab, a collection or an article (one name each), else a redirect from an old slug, else a 404. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/**
 * Guides (first: Basics, Billing › Invoices, a collection with nothing listed, and an article in
 * none), API (Endpoints, and Enterprise for one reader group), and Partners (only for another).
 */
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(null);
  for (const name of ["Guides", "API", "Partners"]) {
    await call(createTab, as(), { name });
  }
  await call(createCollection, as(), { name: "Basics", description: "Start here." });
  await call(createCollection, as(), { name: "Billing" });
  await call(createCollection, as(), { name: "Invoices", parent: "billing" });
  await call(createCollection, as(), { name: "Later" });
  await call(createCollection, as(), { name: "Endpoints", tab: "api" });
  await prisma.readerGroup.createMany({ data: ["enterprise", "partners"].map((claim) => ({ projectId: project.id, key: claim, name: claim, claim })) });
  await call(createCollection, as(), { name: "Enterprise", tab: "api", groups: ["enterprise"] });
  await call(createCollection, as(), { name: "Agreements", tab: "partners", groups: ["partners"] });
  for (const [title, collection, listing] of [
    ["Start here", "basics", "everywhere"],
    ["Secret handshake", "basics", "unlisted"],
    ["Downloading invoices", "invoices", "everywhere"],
    ["Coming soon", "later", "unlisted"],
    ["Listing posts", "endpoints", "everywhere"],
    ["SAML", "enterprise", "everywhere"],
    ["Reseller terms", "agreements", "everywhere"],
    ["Contact us", null, "everywhere"],
  ] as const) {
    const { slug } = await call(createArticle, as(), { title, body: `${title}.`, collection });
    await call(updateArticle, as(), { slug, listing });
    await call(publishArticle, as(), { slug });
  }
});

/** What a reader gets at /docs/<slug>: "308 <where>", "404", or what the page shows. */
async function served(slug: string) {
  const outcome = await DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug }) } as never).then(
    () => null,
    (error: { digest?: string }) => {
      const redirect = error.digest?.match(/^NEXT_REDIRECT;\w+;([^;]+);(\d+);/);
      return redirect ? `${redirect[2]} ${redirect[1]}` : error.digest === "NEXT_HTTP_ERROR_FALLBACK;404" ? "404" : Promise.reject(error);
    },
  );
  if (outcome) {
    return outcome;
  }
  const page = (await docsPage(project.slug, slug))!;
  switch (page.kind) {
    case "article":
      return { article: page.article.title };
    case "tab":
      return { tab: page.tab.slug, collections: page.tab.collections.map((c) => c.slug) };
    case "collection":
      return {
        collection: page.collection.slug,
        tab: page.tab?.slug,
        parent: page.parent?.slug,
        articles: page.collection.articles.map((a) => a.slug),
        collections: page.collection.collections.map((c) => c.slug),
      };
  }
  throw new Error(`Unexpected ${page.kind}`);
}

async function asMemberOf(groups: string[]) {
  const member = await signUp("From the app");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: `user-${groups.join()}`, userId: member.id, groups } });
  actAs(member);
}

describe("what each path serves", () => {
  test("the first tab is /docs; the others, their collections and articles have a page each", async () => {
    expect(await served("guides")).toBe("308 /docs");
    expect(await served("api")).toEqual({ tab: "api", collections: ["endpoints"] });
    // A collection: its listed articles, then the collections in it.
    expect(await served("basics")).toEqual({ collection: "basics", tab: "guides", parent: undefined, articles: ["start-here"], collections: [] });
    expect(await served("billing")).toEqual({ collection: "billing", tab: "guides", parent: undefined, articles: [], collections: ["invoices"] });
    expect(await served("invoices")).toEqual({
      collection: "invoices",
      tab: "guides",
      parent: "billing",
      articles: ["downloading-invoices"],
      collections: [],
    });
    expect(await served("listing-posts")).toEqual({ article: "Listing posts" });
    expect(await served("nothing-here")).toBe("404");
  });

  test("an unlisted article has its page but isn't on its collection's; a collection with nothing listed has none", async () => {
    expect(await served("secret-handshake")).toEqual({ article: "Secret handshake" });
    expect(await served("coming-soon")).toEqual({ article: "Coming soon" });
    expect(await served("later")).toBe("404");
  });

  test("a collection for some groups (and a tab with only such) is a 404 to everyone else", async () => {
    expect(await served("enterprise")).toBe("404");
    expect(await served("saml")).toBe("404");
    expect(await served("partners")).toBe("404");
    expect(await served("agreements")).toBe("404");

    await asMemberOf(["enterprise"]);
    expect(await served("enterprise")).toMatchObject({ collection: "enterprise", tab: "api", articles: ["saml"] });
    expect(await served("api")).toEqual({ tab: "api", collections: ["endpoints", "enterprise"] });
    expect(await served("partners")).toBe("404");
  });

  test("tabs' and collections' old slugs redirect, while the reader may read them there", async () => {
    await call(updateTab, as(), { slug: "api", name: "API reference" });
    await call(updateCollection, as(), { slug: "billing", name: "Payments" });
    await call(updateTab, as(), { slug: "guides", name: "Handbook" });
    await call(updateCollection, as(), { slug: "enterprise", name: "SSO" });
    await call(updateCollection, as(), { slug: "later", name: "Soon" });
    expect(await served("api")).toBe("308 /docs/api-reference");
    expect(await served("billing")).toBe("308 /docs/payments");
    // The first tab's old slug: /docs, where it is.
    expect(await served("guides")).toBe("308 /docs");
    expect(await served("handbook")).toBe("308 /docs");
    // Not to a page this reader can't see there.
    expect(await served("enterprise")).toBe("404");
    expect(await served("later")).toBe("404");
    await asMemberOf(["enterprise"]);
    expect(await served("enterprise")).toBe("308 /docs/sso");
  });
});

describe("for search engines", () => {
  const meta = async (slug: string) => {
    const { title, description, alternates, robots } = await slugMetadata({ params: Promise.resolve({ project: project.slug, slug }) } as never);
    return { title, description, canonical: alternates?.canonical, robots };
  };

  test("tab and collection pages have a title and their own canonical address; /docs searches aren't indexed", async () => {
    const portal = `http://${project.slug}.localhost:3100`;
    expect(await meta("api")).toEqual({ title: "API · Docs", canonical: `${portal}/docs/api` });
    expect(await meta("basics")).toEqual({ title: "Basics · Docs", description: "Start here.", canonical: `${portal}/docs/basics` });
    const docs = (q?: string) => docsMetadata({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({ q }) } as never);
    expect(await docs()).toEqual({ title: "Docs", alternates: { canonical: `${portal}/docs` } });
    expect(await docs("invoices")).toEqual({ title: "Docs", alternates: { canonical: `${portal}/docs` }, robots: { index: false } });
  });

  test("the sitemap lists the tabs' and collections' pages for everyone (the first tab is /docs)", async () => {
    const xml = await (await sitemap(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
    const docs = [...xml.matchAll(/<loc>[^<]*?(\/docs[^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(docs).toEqual(
      expect.arrayContaining(["/docs", "/docs/api", "/docs/basics", "/docs/billing", "/docs/invoices", "/docs/endpoints", "/docs/start-here"]),
    );
    for (const left of ["/docs/guides", "/docs/later", "/docs/enterprise", "/docs/partners", "/docs/agreements", "/docs/saml"]) {
      expect(docs).not.toContain(left);
    }
  });
});
