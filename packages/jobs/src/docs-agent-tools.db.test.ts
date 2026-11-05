import { fromPlainText, toChunks } from "@tuti/content";
import { prisma } from "@tuti/db";
import { articleChunkText } from "@tuti/shared";
import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { articleChanged } from "./articles";
import { runTool, type ToolContext } from "./docs-agent-tools";

let openai: OpenAIFake;
beforeAll(async () => {
  openai = await startOpenAIFake();
});
afterAll(() => openai.close());
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
});

const log = { info: () => {}, warn: () => {} };
/** What's embedded for an article of one paragraph. */
const embedded = (title: string, body: string) => articleChunkText(title, toChunks(fromPlainText(body))[0]!);

async function helpCenter(slug: string) {
  const project = await prisma.project.create({ data: { slug, name: slug } });
  const article = (data: { slug: string; title: string; body: string; published?: boolean; deleted?: boolean; sample?: boolean }) =>
    prisma.article.create({
      data: {
        projectId: project.id,
        slug: data.slug,
        title: data.title,
        body: data.body,
        content: fromPlainText(data.body),
        publishedAt: data.published ? new Date() : null,
        deletedAt: data.deleted ? new Date() : null,
        sample: data.sample ?? false,
      },
    });
  return { project, article, context: { projectId: project.id, repository: { unavailable: "not needed" } } satisfies ToolContext };
}

test("read_article reads an article's or draft's newest text as Markdown, with its state, capped", async () => {
  const { article, context } = await helpCenter("read-article");
  const billing = await article({ slug: "billing", title: "Billing", body: "Invoices go out monthly.", published: true });
  await article({ slug: "exports", title: "Exports", body: "Export to CSV from Settings.", published: true });
  await prisma.articleChanges.create({ data: { articleId: billing.id, title: "Billing and invoices", body: "Invoices go out weekly.", content: fromPlainText("Invoices go out *weekly*.") } });
  await article({ slug: "sso", title: "Single sign-on", body: "Okta works.", published: false });
  await article({ slug: "gone", title: "Gone", body: "Deleted.", deleted: true });
  const other = await prisma.project.create({ data: { slug: "read-article-other", name: "Other" } });
  await prisma.article.create({ data: { projectId: other.id, slug: "elsewhere", title: "Elsewhere", body: "Not this project's." } });

  const read = (slug: string, limits?: ToolContext["limits"]) => runTool({ ...context, limits }, { name: "read_article", arguments: JSON.stringify({ slug }) });
  expect(await read("exports")).toBe("Title: Exports\nState: published\n\nExport to CSV from Settings.");
  expect(await read("billing")).toBe("Title: Billing and invoices\nState: published, with unpublished changes (shown here)\n\nInvoices go out \\*weekly\\*.");
  expect(await read("sso")).toBe("Title: Single sign-on\nState: draft\n\nOkta works.");
  expect(await read("exports", { articleChars: 14 })).toBe("Title: Exports\n[cut at 14 characters]");
  for (const slug of ["gone", "elsewhere", "nothing"]) {
    expect(await read(slug)).toBe(`There's no article or draft with the slug ${slug}.`);
  }
});

test("search_articles finds the project's published articles and drafts nearest a query by meaning", async () => {
  const { article, context } = await helpCenter("search-articles");
  openai.setVector("exporting invoices", [1, 0, 0]);
  openai.setVector(embedded("Billing", "Invoices go out monthly."), [0.9, 0.1, 0]);
  openai.setVector(embedded("Exports", "Export to CSV."), [0.6, 0.8, 0]);
  openai.setVector(embedded("Invoice exports", "Download invoices as PDF."), [0.95, 0, 0.05]);
  const published = [
    await article({ slug: "billing", title: "Billing", body: "Invoices go out monthly.", published: true }),
    await article({ slug: "exports", title: "Exports", body: "Export to CSV.", published: true }),
  ];
  for (const { id } of published) {
    await articleChanged({ articleId: id }, log);
  }
  await article({ slug: "invoice-exports", title: "Invoice exports", body: "Download invoices as PDF.", published: false });
  await article({ slug: "unrelated", title: "Unrelated", body: "Nothing alike.", published: false });
  // Sample content is never embedded; one embedded before it became sample content still stays out of the results.
  const sample = await article({ slug: "sample", title: "Sample", body: "Invoices go out monthly.", published: true });
  await articleChanged({ articleId: sample.id }, log);
  await prisma.article.update({ where: { id: sample.id }, data: { sample: true } });
  await article({ slug: "gone", title: "Gone", body: "Invoices go out monthly.", deleted: true });

  const search = (args: unknown) => runTool(context, { name: "search_articles", arguments: JSON.stringify(args) });
  const lines = (await search({ query: "exporting invoices" })).split("\n");
  expect(lines.slice(0, 4)).toEqual([
    "slug\ttitle\tstate\tdistance",
    "invoice-exports\tInvoice exports\tdraft\t0.001",
    "billing\tBilling\tpublished\t0.006",
    "exports\tExports\tpublished\t0.400",
  ]);
  expect(lines.slice(4).map((line) => line.split("\t")[0])).toEqual(["unrelated"]);
  expect(await search({ query: "exporting invoices", k: 2 })).toBe("slug\ttitle\tstate\tdistance\ninvoice-exports\tInvoice exports\tdraft\t0.001\nbilling\tBilling\tpublished\t0.006");
  // The drafts are embedded once per context.
  const draftTexts = openai.inputs.filter((text) => text.startsWith("Invoice exports")).length;
  await search({ query: "exporting invoices", k: 50 });
  expect(openai.inputs.filter((text) => text.startsWith("Invoice exports")).length).toBe(draftTexts);
});

test("search_articles says so when embeddings fail or are off", async () => {
  const { article, context } = await helpCenter("search-articles-off");
  await article({ slug: "draft", title: "Draft", body: "Text.", published: false });
  const search = () => runTool(context, { name: "search_articles", arguments: JSON.stringify({ query: "anything" }) });
  openai.failNext(500);
  expect(await search()).toBe("Searching articles failed: OpenAI embeddings failed (500): fake failure");
  // Tried again on the next search.
  expect(await search()).toMatch(/^slug\ttitle\tstate\tdistance\ndraft\tDraft\tdraft\t/);
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(await search()).toBe("Searching by meaning isn't available on this server; use read_article with a slug you know.");
});
