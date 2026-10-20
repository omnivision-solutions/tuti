import { prisma } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { strFromU8, unzipSync } from "fflate";
import { isValidElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as exportRoute } from "@/app/app/[project]/settings/export/route";
import ArticlePage, { generateMetadata } from "@/app/portal/[project]/(site)/help/[slug]/page";
import { GET as markdown } from "@/app/portal/[project]/(site)/help/[slug]/md/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import WidgetPage from "@/app/portal/[project]/widget/page";
import { type Listing, LISTINGS } from "@/lib/article-listing";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { request } from "@/test/next-headers";

import { saveArticle } from "./help";
import { helpCenter, publishedArticle } from "./help-queries";
import { answerArticle, countArticleView } from "./help-readers";
import { answerSections, searchHelp } from "./help-search";
import { createArticle, getArticle, listArticles, publishArticle, searchArticles, updateArticle } from "./operations/help";
import { answerQuestion } from "./operations/help-ask";
import { call } from "./operations/run";

/**
 * Listing per article: every public reader against the four listings. One project has a published
 * article in each (and a draft); another project has one listed everywhere, which no reader of the
 * first may show. Sections are embedded through the OpenAI fake, answers come from the model fake.
 */

/** What each listing is in. The tests below check every reader against this table. */
const SHOWN: Record<Listing, { listed: boolean; page: boolean; ai: boolean; linked: boolean }> = {
  everywhere: { listed: true, page: true, ai: true, linked: true },
  unlisted: { listed: false, page: true, ai: true, linked: true },
  hidden: { listed: false, page: false, ai: false, linked: false },
  ai_only: { listed: false, page: false, ai: true, linked: false },
};
/** Each listing's article (its slug is `<listing>-guide` with dashes), then the draft and the other project's. */
const slugOf = (listing: Listing) => `${listing.replace("_", "-")}-guide`;
const DRAFT = "draft-guide";
const ELSEWHERE = "elsewhere-guide";
const ALL = [...LISTINGS.map(slugOf), DRAFT, ELSEWHERE];
/** The slugs a reader should show: the articles whose listing is in it. */
const expected = (key: keyof (typeof SHOWN)[Listing]) => LISTINGS.filter((listing) => SHOWN[listing][key]).map(slugOf).sort();

const BODY = "Zebra crossings explained.";
/** Words in no article, so only meaning (the fake's vectors) finds them. */
const QUESTION = "Where should pedestrians walk?";
const along = (similarity: number) => [similarity, Math.sqrt(1 - similarity ** 2)];

let openai: OpenAIFake;
let model: ModelFake;
let owner: TestUser;
let visitor: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let other: Awaited<ReturnType<typeof createProject>>;

const as = (user: TestUser, projectId = project.id) => ({ actor: { kind: "user" as const, userId: user.id }, projectId });

async function write(user: TestUser, projectId: string, title: string, listing: Listing, publish = true) {
  openai.setVector(articleChunkText(title, { heading: "", text: BODY }), along(0.9));
  const article = await call(createArticle, as(user, projectId), { title, body: BODY, listing });
  if (publish) {
    await call(publishArticle, as(user, projectId), { slug: article.slug });
  }
  return article.slug;
}

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
  visitor = await signUp("Visitor");
  project = await createProject(owner);
  other = await createProject(owner);
  for (const listing of LISTINGS) {
    expect(await write(owner, project.id, `${listing.replace("_", " ")} guide`, listing)).toBe(slugOf(listing));
  }
  await write(owner, project.id, "Draft guide", "everywhere", false);
  await write(owner, other.id, "Elsewhere guide", "everywhere");
  request.userAgent = "";
  actAs(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  model.requests.length = 0;
  model.done();
});

const sorted = (slugs: string[]) => [...new Set(slugs)].sort();
/** The slugs among ALL for which `shown` is true. */
async function shownBy(shown: (slug: string) => Promise<boolean>) {
  const results = await Promise.all(ALL.map(async (slug) => [slug, await shown(slug)] as const));
  return results.filter(([, yes]) => yes).map(([slug]) => slug).sort();
}
const linkedSlugs = (text: string) => sorted([...text.matchAll(/\/help\/([a-z-]+)/g)].map((m) => m[1]!));
const params = (more: object = {}) => ({ params: Promise.resolve({ project: project.slug, ...more }) });

describe("the portal", () => {
  test("/help (and the widget's list) shows articles listed everywhere", async () => {
    const { collections, uncollected } = await helpCenter(project.slug);
    expect(sorted([...collections.flatMap((c) => c.articles), ...uncollected].map((a) => a.slug))).toEqual(expected("listed"));
  });

  test("an article's page is there for everywhere and unlisted; hidden and AI-only ones are a 404", async () => {
    expect(await shownBy(async (slug) => (await publishedArticle(project.slug, slug)) !== null)).toEqual(expected("page"));
    const outcome = (slug: string) =>
      ArticlePage(params({ slug }) as never).then(
        () => true,
        (error: { digest?: string }) => (error.digest === "NEXT_HTTP_ERROR_FALLBACK;404" ? false : Promise.reject(error)),
      );
    expect(await shownBy(outcome)).toEqual(expected("page"));
  });

  test("an unlisted page asks search engines not to index it", async () => {
    for (const listing of ["everywhere", "unlisted"] as const) {
      const metadata = await generateMetadata(params({ slug: slugOf(listing) }) as never);
      expect(metadata.robots).toEqual(listing === "unlisted" ? { index: false } : undefined);
      const response = await markdown(new Request("http://x"), params({ slug: slugOf(listing) }) as never);
      expect(response.headers.get("x-robots-tag")).toBe(listing === "unlisted" ? "noindex" : null);
    }
  });

  test("an article's .md is there for everywhere and unlisted; hidden and AI-only ones are a 404", async () => {
    const statuses = await Promise.all(ALL.map(async (slug) => [slug, (await markdown(new Request("http://x"), params({ slug }) as never)).status]));
    expect(statuses.filter(([, status]) => status === 200).map(([slug]) => slug).sort()).toEqual(expected("page"));
    expect(statuses.every(([, status]) => status === 200 || status === 404)).toBe(true);
  });

  test("the sitemap and llms.txt list articles listed everywhere", async () => {
    const xml = await (await sitemap(new Request("http://x"), params() as never)).text();
    expect(linkedSlugs(xml)).toEqual(expected("listed"));
    const text = await (await llms(new Request("http://x"), params() as never)).text();
    expect(linkedSlugs(text)).toEqual(expected("listed"));
  });

  test("views and “Was this helpful?” count only where the page is served", async () => {
    for (const slug of ALL) {
      await countArticleView(project.slug, slug);
    }
    const viewed = await prisma.articleViewDay.findMany({ where: { article: { projectId: project.id } }, select: { article: { select: { slug: true } } } });
    expect(sorted(viewed.map((v) => v.article.slug))).toEqual(expected("page"));

    expect(await shownBy(async (slug) => !(await answerArticle(project.slug, slug, true)).error)).toEqual(expected("page"));
  });
});

describe("search and AI answers", () => {
  test("search by words finds articles listed everywhere", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(sorted((await searchHelp(project.id, "zebra", 20, [])).map((r) => r.slug))).toEqual(expected("listed"));
  });

  test("search by meaning finds articles listed everywhere, and so does articles.search", async () => {
    expect(sorted((await searchHelp(project.id, QUESTION, 20, [])).map((r) => r.slug))).toEqual(expected("listed"));
    expect(sorted((await call(searchArticles, as(visitor), { q: QUESTION })).results.map((r) => r.slug))).toEqual(expected("listed"));
  });

  test("AI answers use every listing but hidden; an AI-only source is named without a link", async () => {
    const sections = (await answerSections(project.id, QUESTION, 20, [], 3000))!;
    expect(sorted(sections.map((s) => s.slug))).toEqual(expected("ai"));

    model.reply(JSON.stringify({ answer: "Use the zebra crossing.", sources: sections.map((_, i) => `s${i + 1}`) }));
    const answer = await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", []);
    expect(answer.status).toBe("answered");
    expect(Object.fromEntries(answer.sources.map((s) => [s.slug, s.url]))).toEqual(
      Object.fromEntries(
        LISTINGS.filter((l) => SHOWN[l].ai).map((l) => [slugOf(l), SHOWN[l].linked ? `http://${project.slug}.localhost:3100/help/${slugOf(l)}` : null]),
      ),
    );
  });

  test("an article hidden while the model writes isn't shown or offered; one made AI only since isn't linked", async () => {
    const slug = slugOf("everywhere");
    // The model cites every section it's given, while the team changes the article's listing.
    const citeAllWhile = (listing: Listing) =>
      model.reply(JSON.stringify({ answer: "Use the zebra crossing.", sources: ["s1", "s2", "s3"] }), () =>
        call(updateArticle, as(owner), { slug, listing }),
      );
    citeAllWhile("hidden");
    expect(await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", [])).toMatchObject({ status: "no_answer", sources: [] });

    await call(updateArticle, as(owner), { slug, listing: "everywhere" });
    citeAllWhile("ai_only");
    const answer = await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", []);
    expect(answer.sources.find((s) => s.slug === slug)).toEqual({ slug, title: "everywhere guide", url: null });

    // When the model is too slow, the closest articles are offered instead: not one hidden meanwhile.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    model.reply("Too late", async () => {
      await call(updateArticle, as(owner), { slug: slugOf("unlisted"), listing: "hidden" });
      await held;
    });
    try {
      const failed = await answerQuestion(project.id, "reader-1", QUESTION, "PORTAL", [], 1000);
      expect(failed.status).toBe("failed");
      expect(sorted(failed.sources.map((s) => s.slug))).toEqual([slug, slugOf("ai_only")].sort());
    } finally {
      release();
    }
  });
});

describe("the API, the widget and the export", () => {
  test("articles.list and articles.get: the public sees what the portal shows, the team sees every listing", async () => {
    const listed = async (user: TestUser) => (await call(listArticles, as(user), { status: "published" })).articles.map((a) => a.slug).sort();
    expect(await listed(visitor)).toEqual(expected("listed"));
    expect(await listed(owner)).toEqual(LISTINGS.map(slugOf).sort());

    const got = (user: TestUser) => (slug: string) => call(getArticle, as(user), { slug }).then(() => true, (error: { status?: number }) => (error.status === 404 ? false : Promise.reject(error)));
    expect(await shownBy(got(visitor))).toEqual(expected("page"));
    expect(await shownBy(got(owner))).toEqual([...LISTINGS.map(slugOf), DRAFT].sort());
    expect(await call(getArticle, as(owner), { slug: slugOf("ai_only") })).toMatchObject({ status: "published", listing: "ai_only" });
  });

  test("the widget has a Help tab once an article is listed, or when it's asked for one (an unlisted one, say)", async () => {
    const tabs = async (searchParams: object = {}) => {
      const hrefs: string[] = [];
      const walk = (node: ReactNode): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
        } else if (isValidElement<{ href?: unknown; children?: ReactNode }>(node)) {
          if (typeof node.props.href === "string") {
            hrefs.push(node.props.href);
          }
          walk(node.props.children);
        }
      };
      walk((await WidgetPage({ ...params(), searchParams: Promise.resolve(searchParams) } as never)) as ReactNode);
      return hrefs.includes("/widget?tab=help");
    };
    expect(await tabs()).toBe(true);
    await call(updateArticle, as(owner), { slug: slugOf("everywhere"), listing: "unlisted" });
    expect(await tabs()).toBe(false);
    expect(await tabs({ tab: "help", article: slugOf("unlisted") })).toBe(true);
  });

  test("the export has every listing, each saying which", async () => {
    actAs(owner);
    const zip = unzipSync(new Uint8Array(await (await exportRoute(new Request("http://x"), params() as never)).arrayBuffer()));
    for (const listing of LISTINGS) {
      expect(strFromU8(zip[`help/${slugOf(listing)}.md`]!)).toContain(`\nlisting: "${listing}"\n`);
    }
  });

  test("listing is checked: one of the four, set on create and update, and the editor saves it", async () => {
    for (const listing of ["secret", "HIDDEN", ""]) {
      await expect(call(createArticle, as(owner), { title: "Bad listing", listing } as never)).rejects.toMatchObject({ status: 400 });
      await expect(call(updateArticle, as(owner), { slug: slugOf("hidden"), listing } as never)).rejects.toMatchObject({ status: 400 });
    }
    expect((await call(createArticle, as(owner), { title: "Defaults" })).listing).toBe("everywhere");
    // Leaving it out leaves it.
    expect((await call(updateArticle, as(owner), { slug: slugOf("hidden"), title: "Hidden guide v2" })).listing).toBe("hidden");

    actAs(owner);
    const form = new FormData();
    form.set("title", "Hidden guide v2");
    form.set("listing", "ai_only");
    expect(await saveArticle(project.slug, slugOf("hidden"), {}, form)).toEqual({});
    expect((await call(getArticle, as(owner), { slug: slugOf("hidden") })).listing).toBe("ai_only");
    form.set("listing", "nowhere");
    expect((await saveArticle(project.slug, slugOf("hidden"), {}, form)).error).toBeTruthy();
  });
});
