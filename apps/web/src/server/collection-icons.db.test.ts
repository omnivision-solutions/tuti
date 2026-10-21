import { prisma } from "@tuti/db";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, expect, test } from "vitest";

import { GET as exportZip } from "@/app/app/[project]/settings/export/route";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { createArticle, createCollection, listCollections, updateCollection } from "./operations/docs";
import { call } from "./operations/run";

/** A collection's Lucide icon, by name: set, changed, removed, listed and exported; unknown names refused. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const icons = async () => (await call(listCollections, as(), {})).collections.map((c) => `${c.slug}:${c.icon}`);

test("a collection's icon is set, changed and removed by name, and listed", async () => {
  expect(await call(createCollection, as(), { name: "Basics" })).toMatchObject({ slug: "basics", icon: null });
  expect(await call(createCollection, as(), { name: "Billing", icon: "credit-card" })).toMatchObject({ icon: "credit-card" });
  expect(await icons()).toEqual(["basics:null", "billing:credit-card"]);

  await call(updateCollection, as(), { slug: "basics", icon: "rocket" });
  // Left out, it stays.
  await call(updateCollection, as(), { slug: "billing", description: "Paying us." });
  expect(await icons()).toEqual(["basics:rocket", "billing:credit-card"]);

  expect(await call(updateCollection, as(), { slug: "basics", icon: null })).toMatchObject({ icon: null });
  expect(await icons()).toEqual(["basics:null", "billing:credit-card"]);
});

test("an icon Lucide doesn't have is refused", async () => {
  const refused = { status: 400, code: "invalid_input", message: "No icon named “not-an-icon”" };
  await expect(call(createCollection, as(), { name: "Basics", icon: "not-an-icon" })).rejects.toMatchObject(refused);
  await call(createCollection, as(), { name: "Basics", icon: "rocket" });
  await expect(call(updateCollection, as(), { slug: "basics", icon: "not-an-icon" })).rejects.toMatchObject(refused);
  // Nor a name from the object's prototype.
  await expect(call(updateCollection, as(), { slug: "basics", icon: "constructor" })).rejects.toMatchObject({ status: 400 });
  expect(await icons()).toEqual(["basics:rocket"]);
});

test("an icon Lucide dropped since doesn't block saving the collection; a new unknown one is still refused", async () => {
  await call(createCollection, as(), { name: "Basics" });
  await prisma.collection.update({ where: { projectId_slug: { projectId: project.id, slug: "basics" } }, data: { icon: "dropped-icon" } });
  // The dialog sends the stored icon back with the other fields.
  expect(await call(updateCollection, as(), { slug: "basics", name: "The basics", icon: "dropped-icon" })).toMatchObject({
    slug: "the-basics",
    icon: "dropped-icon",
  });
  await expect(call(updateCollection, as(), { slug: "the-basics", icon: "another-unknown" })).rejects.toMatchObject({
    status: 400,
    message: "No icon named “another-unknown”",
  });
  expect(await icons()).toEqual(["the-basics:dropped-icon"]);
});

test("the export has an article's collection's icon in its front matter", async () => {
  await call(createCollection, as(), { name: "Billing", icon: "credit-card" });
  await call(createCollection, as(), { name: "Basics" });
  await call(createArticle, as(), { title: "Invoices", body: "Where to find them.", collection: "billing" });
  await call(createArticle, as(), { title: "Start here", body: "Hello.", collection: "basics" });

  actAs(owner);
  const params = Promise.resolve({ project: project.slug });
  const files = unzipSync(new Uint8Array(await (await exportZip(new Request("http://x"), { params })).arrayBuffer()));
  expect(strFromU8(files["docs/billing/invoices.md"]!)).toContain('collectionIcon: "credit-card"');
  expect(strFromU8(files["docs/basics/start-here.md"]!)).not.toContain("collectionIcon");
});
