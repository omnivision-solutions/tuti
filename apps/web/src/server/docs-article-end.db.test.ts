import { type ArticleListing, prisma, type ReadAccess } from "@tuti/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";

import { StillStuck } from "@/components/docs-assistant";
import { DocsAssistantContext } from "@/components/docs-assistant-context";
import { SIGNED_OUT } from "@/lib/read-access";
import { createProject, signUp } from "@/test/helpers";

import { articleEnd, docsContents } from "./docs-queries";

/** The end of an article on the portal: previous and next in reading order, and related articles, of what this reader may open and is listed. */

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  project = await createProject(await signUp("Owner"));
});

async function collection(slug: string, order: number) {
  return prisma.collection.create({ data: { projectId: project.id, slug, name: slug, order } });
}

let order = 0;
async function article(
  title: string,
  collectionId: string | null,
  data: { listing?: ArticleListing; access?: ReadAccess; noAccess?: "LOCK"; vector?: number[] } = {},
) {
  const { vector, ...rest } = data;
  const slug = title.toLowerCase().replaceAll(" ", "-");
  const { id } = await prisma.article.create({
    data: { projectId: project.id, collectionId, slug, title, body: title, publishedAt: new Date(), order: order++, ...rest },
  });
  if (vector) {
    // A section's embedding: `vector`, then zeros.
    const literal = `[${[...vector, ...Array<number>(1536 - vector.length).fill(0)].join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO article_chunk (id, "articleId", "projectId", position, heading, text, model, "contentHash", embedding)
      VALUES (${`chunk-${slug}`}, ${id}, ${project.id}, 0, '', ${title}, 'test', 'hash', ${literal}::vector)`;
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

test("“Still stuck?” offers only what's set up: nothing without the assistant or a contact button, Ask AI with the assistant", async () => {
  expect(renderToStaticMarkup(createElement(StillStuck))).toBe("");
  const assistant = { ask: () => {}, open: () => {}, continueWith: () => {} };
  const html = renderToStaticMarkup(createElement(DocsAssistantContext, { value: assistant }, createElement(StillStuck)));
  expect(html).toContain("Still stuck?");
  expect(html).toContain("Ask AI");
  expect(html).not.toContain("Contact us");
});
