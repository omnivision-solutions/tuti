import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";

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
