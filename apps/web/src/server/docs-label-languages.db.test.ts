import { prisma } from "@tuti/db";
import { labelSource } from "@tuti/jobs";
import { beforeEach, expect, test } from "vitest";

import { createProject, signUp, type TestUser } from "@/test/helpers";
import { SIGNED_OUT } from "@/lib/read-access";
import { request } from "@/test/next-headers";

import { docsContents, docsTree } from "./docs-queries";
import { createArticle, createCollection, createTab, publishArticle } from "./operations/docs";
import { updateLanguages } from "./operations/languages";
import { call } from "./operations/run";

/** The docs' collection and tab names in the page's language (docs/plan.md L9). */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** A page's request at `language`'s address, as proxy.ts sends it on (null: the default language's). */
const at = (language: string | null) =>
  (request.headers = language ? { "x-tuti-language": language, "x-tuti-language-prefix": `/${language}`, "x-tuti-language-default": "en" } : { "x-tuti-language": "en", "x-tuti-language-default": "en" });

/** Billing (in the Guides tab, with a published article), German live and written by the team: Billing and Guides named in German. */
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  request.headers = {};
  await call(updateLanguages, as(), { languages: [{ code: "de", live: true, newPages: "manual" }] });
  await call(createTab, as(), { name: "Guides" });
  await call(createCollection, as(), { name: "Billing", description: "Paying and invoices." });
  await call(createArticle, as(), { title: "Paying by card", body: "Pay by card.", collection: "billing" });
  await call(publishArticle, as(), { slug: "paying-by-card" });
  await prisma.collection.updateMany({
    where: { projectId: project.id },
    data: { translations: { de: { name: "Abrechnung", description: "Bezahlen und Rechnungen.", auto: false, source: labelSource("Billing", "Paying and invoices.") } } },
  });
  await prisma.docsTab.updateMany({ where: { projectId: project.id }, data: { translations: { de: { name: "Anleitungen", auto: false, source: labelSource("Guides") } } } });
});

test("at a language's address, collections and tabs translated there have their names in it, marked as in it", async () => {
  at("de");
  const docs = await docsContents(project.slug);
  expect(docs.tabs[0]).toMatchObject({ name: "Anleitungen", lang: "de" });
  expect(docs.collections[0]).toMatchObject({ name: "Abrechnung", description: "Bezahlen und Rechnungen.", lang: "de" });
  // The tree beside every docs page too.
  expect(docsTree(docs, null, null).collections[0]).toMatchObject({ name: "Abrechnung", lang: "de" });
});

test("at the default language's address, or one it isn't translated into, the team's names", async () => {
  at(null);
  const docs = await docsContents(project.slug);
  expect(docs.collections[0]).toMatchObject({ name: "Billing", description: "Paying and invoices." });
  expect(docs.collections[0]).not.toHaveProperty("lang");
  expect(docs.tabs[0]).not.toHaveProperty("lang");
  at("fr");
  expect((await docsContents(project.slug)).collections[0]).toMatchObject({ name: "Billing" });
});

test("a translation kept up to date made from the name as it was is never shown: the team's name until it's translated again", async () => {
  await prisma.collection.updateMany({
    where: { projectId: project.id },
    data: { translations: { de: { name: "Abrechnung", description: "Bezahlen.", auto: true, source: labelSource("Billing", "Paying.") } } },
  });
  at("de");
  const [collection] = (await docsContents(project.slug)).collections;
  expect(collection).toMatchObject({ name: "Billing", description: "Paying and invoices." });
  expect(collection).not.toHaveProperty("lang");
});

test("locked for this reader, a tab and its collections still show their names in the page's language, marked as in it", async () => {
  await prisma.docsTab.updateMany({ where: { projectId: project.id }, data: { access: "SIGNED_IN", noAccess: "LOCK" } });
  at("de");
  const docs = await docsContents(project.slug, { reader: SIGNED_OUT });
  expect(docs.tabs[0]).toMatchObject({ name: "Anleitungen", lang: "de", locked: true });
  expect(docs.collections[0]).toMatchObject({ name: "Abrechnung", lang: "de", locked: true });
});
