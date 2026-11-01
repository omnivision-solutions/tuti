import { type ArticleListing, prisma, type ReadAccess } from "@tuti/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";

import { StillStuck } from "@/components/docs-assistant";
import { DocsAssistantContext } from "@/components/docs-assistant-context";
import { LookContext } from "@/components/portal-look";
import { DEFAULT_LOOK } from "@/lib/portal-look";
import { SIGNED_OUT } from "@/lib/read-access";
import { createProject, signUp } from "@/test/helpers";

import { articleEnd, docsContents } from "./docs-queries";

/** The end of an article on the portal: previous and next in reading order, and related articles, of what this reader may open and is listed. */

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  project = await createProject(await signUp("Owner"));
});

async function collection(slug: string, order: number, tabId?: string) {
  return prisma.collection.create({ data: { projectId: project.id, slug, name: slug, order, tabId } });
}

async function tab(slug: string, order: number) {
  return prisma.docsTab.create({ data: { projectId: project.id, slug, name: slug, order } });
}

/** Article `slug`'s one section embedded (again) as `vector`, then zeros, as the embedding job replaces them; null removes them. */
async function embed(slug: string, vector: number[] | null) {
  const { id } = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug }, select: { id: true } });
  await prisma.articleChunk.deleteMany({ where: { articleId: id } });
  if (vector) {
    const literal = `[${[...vector, ...Array<number>(1536 - vector.length).fill(0)].join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO article_chunk (id, "articleId", "projectId", position, heading, text, model, "contentHash", embedding)
      VALUES (${`chunk-${project.id}-${slug}`}, ${id}, ${project.id}, 0, '', ${slug}, 'test', 'hash', ${literal}::vector)`;
  }
}

let order = 0;
async function article(
  title: string,
  collectionId: string | null,
  data: { listing?: ArticleListing; access?: ReadAccess; noAccess?: "LOCK"; vector?: number[] } = {},
) {
  const { vector, ...rest } = data;
  const slug = title.toLowerCase().replaceAll(" ", "-");
  await prisma.article.create({
    data: { projectId: project.id, collectionId, slug, title, body: title, publishedAt: new Date(), order: order++, ...rest },
  });
  if (vector) {
    await embed(slug, vector);
  }
  return slug;
}

const end = async (slug: string, collection: string | null) => {
  const result = await articleEnd(project.slug, slug, collection, await docsContents(project.slug, { reader: SIGNED_OUT }));
  return { previous: result.previous?.slug ?? null, next: result.next?.slug ?? null, related: result.related.map((a) => a.slug) };
};

test("previous and next in reading order, into the next collection and then the articles in none; only listed ones this reader may open", async () => {
  const start = await collection("getting-started", 0);
  const billing = await collection("billing", 1);
  await article("Welcome", start.id);
  await article("Install", start.id);
  // Not for this reader (locked or hidden from them), or not in the lists: skipped.
  await article("Pro setup", start.id, { access: "SIGNED_IN", noAccess: "LOCK" });
  await article("Secret", start.id, { access: "SIGNED_IN" });
  await article("Unlisted", start.id, { listing: "UNLISTED" });
  await article("Hidden", start.id, { listing: "HIDDEN" });
  await article("Ai only", start.id, { listing: "AI_ONLY" });
  await article("Plans", billing.id);
  await article("Glossary", null);

  expect(await end("welcome", "getting-started")).toMatchObject({ previous: null, next: "install" });
  expect(await end("install", "getting-started")).toMatchObject({ previous: "welcome", next: "plans" });
  expect(await end("plans", "billing")).toMatchObject({ previous: "install", next: "glossary" });
  expect(await end("glossary", null)).toMatchObject({ previous: "plans", next: null });
  // An unlisted article is in no order.
  expect(await end("unlisted", "getting-started")).toMatchObject({ previous: null, next: null });
});

test("related: the ones alike in meaning, closest first, then the rest of its collection; never itself, the previous or next one, or what this reader can't open", async () => {
  const guides = await collection("guides", 0);
  const other = await collection("other", 1);
  await article("Sso", guides.id, { vector: [1, 0] });
  await article("Roles", guides.id, { vector: [0, 1] });
  await article("Audit log", guides.id);
  await article("Exports", guides.id, { vector: [0, 1] });
  await article("Saml setup", other.id, { vector: [0.9, 0.1] });
  await article("Scim", other.id, { vector: [0.8, 0.2] });
  // Embedded, but not alike.
  await article("Webhooks", other.id, { vector: [0, 1] });
  await article("Okta secret", other.id, { vector: [1, 0], access: "SIGNED_IN" });
  await article("Okta unlisted", other.id, { vector: [1, 0], listing: "UNLISTED" });
  await article("Okta locked", other.id, { vector: [1, 0], access: "SIGNED_IN", noAccess: "LOCK" });

  // Roles is next: left out. The closest by meaning (in another collection), then the collection's in order.
  expect((await end("sso", "guides")).related).toEqual(["saml-setup", "scim", "audit-log"]);
  // Without sections embedded (Audit log): its collection's, in order, but the previous and next.
  expect((await end("audit-log", "guides")).related).toEqual(["sso"]);
});

test("tabs are separate sets of docs: previous, next and related stay in the article's tab", async () => {
  const guides = await tab("guides", 0);
  const api = await tab("api", 1);
  const start = await collection("getting-started", 0, guides.id);
  const endpoints = await collection("endpoints", 0, api.id);
  await article("Welcome", start.id);
  await article("Auth v1", start.id, { vector: [1, 0] });
  // The articles in no collection come under the first tab, after its collections.
  await article("Glossary", null);
  await article("Listing", endpoints.id);
  await article("Paging", endpoints.id);
  await article("Auth v2", endpoints.id, { vector: [1, 0] });

  expect(await end("glossary", null)).toMatchObject({ previous: "auth-v1", next: null });
  expect(await end("listing", "endpoints")).toMatchObject({ previous: null, next: "paging" });
  // Auth v1 is as alike as can be, but in the other tab: Related is its own collection's.
  expect((await end("auth-v2", "endpoints")).related).toEqual(["listing"]);
});

test("related follows an article's sections as they're embedded again, and leaves out one with none left", async () => {
  const one = await collection("one", 0);
  const two = await collection("two", 1);
  await article("Intro", one.id);
  await article("Sso", one.id, { vector: [1, 0] });
  await article("Outro", one.id);
  await article("Saml", two.id, { vector: [0.9, 0.1] });
  await article("Webhooks", two.id, { vector: [0, 1] });

  expect((await end("sso", "one")).related).toEqual(["saml"]);
  await embed("saml", [0, 1]);
  await embed("webhooks", [1, 0]);
  expect((await end("sso", "one")).related).toEqual(["webhooks"]);
  await embed("webhooks", null);
  expect((await end("sso", "one")).related).toEqual([]);
});

test("“Still stuck?” offers only what's set up: nothing without the assistant or a contact button, Ask AI with the assistant, the contact button alone without", async () => {
  expect(renderToStaticMarkup(createElement(StillStuck))).toBe("");
  const assistant = { ask: () => {}, open: () => {}, continueWith: () => {} };
  const html = renderToStaticMarkup(createElement(DocsAssistantContext, { value: assistant }, createElement(StillStuck)));
  expect(html).toContain("Still stuck?");
  expect(html).toContain("Ask AI");
  expect(html).not.toContain("Contact us");
  // A contact button and no assistant: the button alone.
  const look = { ...DEFAULT_LOOK, contact: { label: "", url: "https://acme.example/contact" } };
  const contactOnly = renderToStaticMarkup(createElement(LookContext, { value: look }, createElement(StillStuck)));
  expect(contactOnly).toContain("Still stuck?");
  expect(contactOnly).toContain('href="https://acme.example/contact"');
  expect(contactOnly).toContain("Contact us");
  expect(contactOnly).not.toContain("Ask AI");
});
