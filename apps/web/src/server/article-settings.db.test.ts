import { prisma } from "@tuti/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { generateMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { GET as markdown } from "@/app/portal/[project]/(site)/docs/[slug]/md/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { saveArticle, saveArticleSettings } from "./docs";
import { docsContents } from "./docs-queries";
import { searchDocs } from "./docs-search";
import { createArticle, createCollection, createTab, getArticle, listArticles, publishArticle, updateArticle } from "./operations/docs";
import { call } from "./operations/run";

/** Article settings: a custom slug, a meta description, keywords and "Block search indexing" on articles.*. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** The project's redirects, as "old slug → the article's current slug". */
async function redirects() {
  const rows = await prisma.docsRedirect.findMany({
    where: { projectId: project.id },
    orderBy: { slug: "asc" },
    select: { slug: true, article: { select: { slug: true } } },
  });
  return rows.map((row) => `${row.slug} → ${row.article?.slug}`);
}

describe("a custom slug", () => {
  test("set on create, it stays when the draft is retitled; turned off, the draft follows its title again", async () => {
    const created = await call(createArticle, as(), { title: "Inviting your team", slug: "invites" });
    expect(created).toMatchObject({ slug: "invites", customSlug: true, url: expect.stringMatching(/\/docs\/invites$/) });
    expect(await call(updateArticle, as(), { slug: "invites", title: "Adding teammates" })).toMatchObject({ slug: "invites" });

    expect(await call(updateArticle, as(), { slug: "invites", newSlug: null })).toMatchObject({ slug: "adding-teammates", customSlug: false });
    expect(await call(updateArticle, as(), { slug: "adding-teammates", title: "Seats" })).toMatchObject({ slug: "seats" });
  });

  test("set on a draft, then changed on the published article: every old address redirects to it", async () => {
    await call(createArticle, as(), { title: "Billing" });
    expect(await call(updateArticle, as(), { slug: "billing", newSlug: "payments" })).toMatchObject({ slug: "payments", customSlug: true });
    await call(publishArticle, as(), { slug: "payments" });
    expect(await call(updateArticle, as(), { slug: "payments", newSlug: "paying" })).toMatchObject({ slug: "paying" });
    expect(await redirects()).toEqual(["billing → paying", "payments → paying"]);

    // Turned off on a published article: it keeps the address it has.
    expect(await call(updateArticle, as(), { slug: "paying", newSlug: null, title: "Invoices" })).toMatchObject({
      slug: "paying",
      customSlug: false,
    });
    // Taking an old address back drops its redirect.
    expect(await call(updateArticle, as(), { slug: "paying", newSlug: "billing" })).toMatchObject({ slug: "billing" });
    expect(await redirects()).toEqual(["paying → billing", "payments → billing"]);
  });

  test("one a tab, a collection or another article has is refused, never changed", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(createCollection, as(), { name: "Basics" });
    await call(createArticle, as(), { title: "Billing" });
    await call(createArticle, as(), { title: "Draft" });
    for (const [slug, message] of [
      ["guides", "That address is taken by the tab “Guides”"],
      ["basics", "That address is taken by the collection “Basics”"],
      ["billing", "That address is taken by the article “Billing”"],
    ]) {
      await expect(call(updateArticle, as(), { slug: "draft", newSlug: slug })).rejects.toMatchObject({ status: 409, message });
      await expect(call(createArticle, as(), { title: "Another", slug })).rejects.toMatchObject({ status: 409 });
    }
    expect(await call(getArticle, as(), { slug: "draft" })).toMatchObject({ customSlug: false });
    // Its own slug is fine.
    expect(await call(updateArticle, as(), { slug: "draft", newSlug: "draft" })).toMatchObject({ slug: "draft", customSlug: true });
  });

  test("reserved and malformed slugs are refused", async () => {
    await call(createArticle, as(), { title: "Draft" });
    for (const slug of ["new", "insights", "api"]) {
      await expect(call(updateArticle, as(), { slug: "draft", newSlug: slug })).rejects.toMatchObject({ status: 400 });
    }
    for (const slug of ["Billing", "two words", "-billing", "billing-", "billing--2", "billing.md"]) {
      await expect(call(updateArticle, as(), { slug: "draft", newSlug: slug })).rejects.toMatchObject({ status: 400 });
    }
    expect(await call(getArticle, as(), { slug: "draft" })).toMatchObject({ slug: "draft" });
  });

  test("two articles asking for the same one at once: one gets it, the other is refused", async () => {
    await call(createArticle, as(), { title: "One" });
    await call(createArticle, as(), { title: "Two" });
    const results = await Promise.allSettled([
      call(updateArticle, as(), { slug: "one", newSlug: "billing" }),
      call(updateArticle, as(), { slug: "two", newSlug: "billing" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("description, keywords and noindex", () => {
  test("are saved on create and update, at once on a published article, and returned to the team", async () => {
    await call(createArticle, as(), {
      title: "Billing",
      description: "  How we charge.  ",
      keywords: [" invoice ", "Receipt", "receipt", "VAT"],
      noindex: true,
    });
    expect(await call(getArticle, as(), { slug: "billing" })).toMatchObject({
      description: "How we charge.",
      // Trimmed; the same word twice (in any case) once, as first written.
      keywords: ["invoice", "Receipt", "VAT"],
      noindex: true,
    });
    await call(publishArticle, as(), { slug: "billing" });
    const updated = await call(updateArticle, as(), { slug: "billing", description: "", keywords: [], noindex: false });
    expect(updated).toMatchObject({ description: "", keywords: [], noindex: false, changes: null });
    expect((await call(listArticles, as(), {})).articles[0]).toMatchObject({ slug: "billing", description: "", keywords: [], noindex: false });
  });

  test("are checked: up to 300 characters, 20 keywords of up to 60", async () => {
    await call(createArticle, as(), { title: "Billing" });
    const invalid = [
      { description: "x".repeat(301) },
      { keywords: Array.from({ length: 21 }, (_, i) => `word ${i}`) },
      { keywords: ["x".repeat(61)] },
      { keywords: [" "] },
    ];
    for (const input of invalid) {
      await expect(call(updateArticle, as(), { slug: "billing", ...input })).rejects.toMatchObject({ status: 400 });
    }
  });

  test("readers' articles.get and articles.list don't show them", async () => {
    await call(createArticle, as(), { title: "Billing", description: "How we charge.", keywords: ["invoice"] });
    await call(publishArticle, as(), { slug: "billing" });
    const reader = { actor: { kind: "user" as const, userId: (await signUp("Reader")).id }, projectId: project.id };
    const article = await call(getArticle, reader, { slug: "billing" });
    expect(article).not.toHaveProperty("keywords");
    expect(article).not.toHaveProperty("customSlug");
    expect((await call(listArticles, reader, {})).articles[0]).not.toHaveProperty("keywords");
  });
});

describe("the editor's Settings dialog", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      data.set(key, value);
    }
    return data;
  };
  /** The action's redirect (its new address), or its result. */
  const save = (slug: string, fields: Record<string, string>) =>
    saveArticleSettings(project.slug, slug, {}, form(fields)).then(
      (result) => result,
      (error: { digest?: string }) => error.digest?.split(";")[2] ?? Promise.reject(error),
    );

  test("saves its fields only, keywords by commas or lines, and opens the new address", async () => {
    actAs(owner);
    await call(createArticle, as(), { title: "Billing", body: "Pay by card." });
    const fields = { customSlug: "on", newSlug: " payments ", description: "How we charge.", keywords: "invoice,\nVAT , ,receipts", noindex: "on" };
    expect(await save("billing", fields)).toBe(`/app/${project.slug}/docs/payments`);
    expect(await call(getArticle, as(), { slug: "payments" })).toMatchObject({
      title: "Billing",
      body: "Pay by card.",
      customSlug: true,
      description: "How we charge.",
      keywords: ["invoice", "VAT", "receipts"],
      noindex: true,
    });
    // Unticked: back to the title's; a clash is said, not changed.
    expect(await save("payments", {})).toBe(`/app/${project.slug}/docs/billing`);
    expect(await call(getArticle, as(), { slug: "billing" })).toMatchObject({ customSlug: false, description: "", keywords: [], noindex: false });
    await call(createArticle, as(), { title: "Refunds" });
    expect(await save("refunds", { customSlug: "on", newSlug: "billing" })).toEqual({ error: "That address is taken by the article “Billing”" });
  });

  test("saves the collection and updated date too, as the editor's Save does: on a published article a new collection waits to be published", async () => {
    actAs(owner);
    await call(createCollection, as(), { name: "Basics" });
    await call(createArticle, as(), { title: "Billing", body: "Pay by card." });
    await call(publishArticle, as(), { slug: "billing" });
    expect(await save("billing", { collection: "basics", showUpdatedDate: "off" })).toEqual({});
    expect(await call(getArticle, as(), { slug: "billing" })).toMatchObject({
      collection: null,
      showUpdatedDate: false,
      changes: { title: "Billing", body: "Pay by card.", collection: { slug: "basics" } },
    });
    // A form without them (the editor's, saving its title and text) leaves them as they are.
    expect(await saveArticle(project.slug, "billing", {}, form({ title: "Paying" }))).toEqual({});
    expect(await save("billing", { description: "How we charge." })).toEqual({});
    expect(await call(getArticle, as(), { slug: "billing" })).toMatchObject({
      showUpdatedDate: false,
      changes: { title: "Paying", collection: { slug: "basics" } },
    });
    // Back to no collection, the article's ticked again.
    expect(await save("billing", { collection: "", showUpdatedDate: "on" })).toEqual({});
    expect(await call(getArticle, as(), { slug: "billing" })).toMatchObject({ showUpdatedDate: true, changes: { title: "Paying", collection: null } });
  });
});

describe("readers' pages", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    actAs(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  const params = (more: object = {}) => ({ params: Promise.resolve({ project: project.slug, ...more }) });
  async function published(title: string, settings: { description?: string; noindex?: boolean } = {}) {
    const { slug } = await call(createArticle, as(), { title, body: "Plans are billed monthly, by card.", ...settings });
    await call(publishArticle, as(), { slug });
    return slug;
  }

  test("the meta description is the team's, else the text's first lines", async () => {
    const own = await published("Billing", { description: "How we charge." });
    expect(await generateMetadata(params({ slug: own }) as never)).toMatchObject({
      description: "How we charge.",
      openGraph: { title: "Billing", description: "How we charge." },
    });
    const plain = await published("Refunds");
    expect(await generateMetadata(params({ slug: plain }) as never)).toMatchObject({ description: "Plans are billed monthly, by card." });
    // The portal's share image and name (the layout's Open Graph) stay under the article's own.
    const portal = { openGraph: { siteName: "Acme Help", images: [{ url: new URL("https://media.example.com/share.jpg") }], description: "The portal's" } };
    expect(await generateMetadata(params({ slug: own }) as never, Promise.resolve(portal) as never)).toMatchObject({
      openGraph: { siteName: "Acme Help", images: [{ url: new URL("https://media.example.com/share.jpg") }], title: "Billing", description: "How we charge." },
    });
  });

  test("blocking search indexing: noindex, out of the sitemap and llms.txt, still listed in the docs and search", async () => {
    const hidden = await published("Billing", { noindex: true });
    const shown = await published("Refunds");

    const metadata = (slug: string) => generateMetadata(params({ slug }) as never);
    expect((await metadata(hidden)).robots).toEqual({ index: false });
    expect((await metadata(shown)).robots).toBeUndefined();
    const md = (slug: string) => markdown(new Request("http://x"), params({ slug }) as never);
    expect((await md(hidden)).headers.get("x-robots-tag")).toBe("noindex");
    expect((await md(shown)).headers.get("x-robots-tag")).toBeNull();

    const xml = await (await sitemap(new Request("http://x"), params() as never)).text();
    expect(xml).toContain(`/docs/${shown}<`);
    expect(xml).not.toContain(`/docs/${hidden}`);
    const text = await (await llms(new Request("http://x"), params() as never)).text();
    expect(text).toContain(`/docs/${shown}.md`);
    expect(text).not.toContain(`/docs/${hidden}`);

    expect((await docsContents(project.slug)).uncollected.map((a) => a.slug)).toEqual([hidden, shown]);
    expect((await searchDocs(project.id, "billed", 10, SIGNED_OUT)).map((r) => r.slug).sort()).toEqual([hidden, shown]);
  });
});
