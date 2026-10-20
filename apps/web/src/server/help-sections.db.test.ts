import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, test } from "vitest";

import { GET as exportZip } from "@/app/app/[project]/settings/export/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { collectionOptions, helpCenter, publishedArticle } from "./help-queries";
import {
  createArticle,
  createCollection,
  createSection,
  deleteCollection,
  deleteSection,
  listCollections,
  listSections,
  publishArticle,
  reorderCollection,
  reorderSection,
  updateCollection,
  updateSection,
} from "./operations/help";
import { call } from "./operations/run";

/**
 * Help center sections (readers' tabs): once there's one, every top-level collection is in one, the
 * ones inside others are in their parent's, and every list is by section, then by order there.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
/** Collections in reading order, as `section:parent/slug`. */
const tree = async () =>
  (await call(listCollections, as(), {})).collections.map((c) => `${c.section ?? "-"}:${c.parent ? `${c.parent}/` : ""}${c.slug}`);
const sections = async () => (await call(listSections, as(), {})).sections.map((s) => `${s.slug}(${s.collections})`);
const collections = (...names: string[]) => names.reduce((done, name) => done.then(() => call(createCollection, as(), { name })), Promise.resolve({}));
const refused = { status: 400, code: "invalid_input" };

describe("sections", () => {
  test("without sections, collections are in none; the first section takes every top-level one, and the ones in them follow", async () => {
    await collections("Basics", "Billing");
    await call(createCollection, as(), { name: "Invoices", parent: "billing" });
    expect(await tree()).toEqual(["-:basics", "-:billing", "-:billing/invoices"]);
    expect(await sections()).toEqual([]);

    expect(await call(createSection, as(), { name: "Guides" })).toMatchObject({ slug: "guides", name: "Guides", order: 0, collections: 2 });
    expect(await tree()).toEqual(["guides:basics", "guides:billing", "guides:billing/invoices"]);
    // A second one starts empty.
    expect(await call(createSection, as(), { name: "API" })).toMatchObject({ slug: "api", order: 1, collections: 0 });
    expect(await sections()).toEqual(["guides(2)", "api(0)"]);
  });

  test("a new top-level collection goes last in the section named, or the first; one inside another has its section", async () => {
    await call(createSection, as(), { name: "Guides" });
    await call(createSection, as(), { name: "API" });
    await collections("Basics");
    expect(await call(createCollection, as(), { name: "Endpoints", section: "api" })).toMatchObject({ section: "api", order: 0 });
    expect(await call(createCollection, as(), { name: "Webhooks", section: "api" })).toMatchObject({ section: "api", order: 1 });
    expect(await call(createCollection, as(), { name: "Signatures", parent: "webhooks" })).toMatchObject({ section: "api", parent: "webhooks" });
    expect(await tree()).toEqual(["guides:basics", "api:endpoints", "api:webhooks", "api:webhooks/signatures"]);

    await expect(call(createCollection, as(), { name: "Nope", section: "nope" })).rejects.toMatchObject({ ...refused, message: "There's no section “nope”" });
    await expect(call(createCollection, as(), { name: "Nope", parent: "webhooks", section: "guides" })).rejects.toMatchObject(refused);
  });

  test("collections move to another section (last, or at a place), with the ones in them; one coming out of another stays in its section", async () => {
    await call(createSection, as(), { name: "Guides" });
    await collections("Basics", "Billing", "Teams");
    await call(createCollection, as(), { name: "Invoices", parent: "billing" });
    await call(createSection, as(), { name: "API" });
    await call(createCollection, as(), { name: "Endpoints", section: "api" });

    expect(await call(reorderCollection, as(), { slug: "billing", section: "api", position: 0 })).toMatchObject({ section: "api", order: 0 });
    expect(await tree()).toEqual(["guides:basics", "guides:teams", "api:billing", "api:billing/invoices", "api:endpoints"]);
    // updateCollection moves it last there.
    expect(await call(updateCollection, as(), { slug: "teams", section: "api" })).toMatchObject({ section: "api", order: 2 });
    // Out of Billing, to the top level: in Billing's section, unless another is named.
    expect(await call(reorderCollection, as(), { slug: "invoices", parent: null })).toMatchObject({ section: "api", parent: null });
    await call(reorderCollection, as(), { slug: "invoices", parent: "billing" });
    expect(await call(reorderCollection, as(), { slug: "invoices", parent: null, section: "guides", position: 0 })).toMatchObject({ section: "guides" });
    expect(await tree()).toEqual(["guides:invoices", "guides:basics", "api:billing", "api:endpoints", "api:teams"]);
    // Into a collection in another section: it's in that one's now.
    expect(await call(reorderCollection, as(), { slug: "basics", parent: "endpoints" })).toMatchObject({ section: "api", parent: "endpoints" });

    await expect(call(reorderCollection, as(), { slug: "basics", section: "guides" })).rejects.toMatchObject({
      ...refused,
      message: "A collection inside another is in that one's section, so it can't have its own",
    });
    await expect(call(reorderCollection, as(), { slug: "teams", section: "nope" })).rejects.toMatchObject(refused);
  });

  test("sections are reordered and renamed, and every list follows: readers, the editor's picker, collections.list", async () => {
    await call(createSection, as(), { name: "Guides" });
    await collections("Basics");
    await call(createSection, as(), { name: "API" });
    await call(createCollection, as(), { name: "Endpoints", section: "api" });
    for (const [title, collection] of [
      ["Start here", "basics"],
      ["List posts", "endpoints"],
    ]) {
      const { slug } = await call(createArticle, as(), { title, body: `${title}.`, collection });
      await call(publishArticle, as(), { slug });
    }
    const reading = async () => (await helpCenter(project.slug)).collections.map((c) => c.slug);
    expect(await reading()).toEqual(["basics", "endpoints"]);

    expect(await call(reorderSection, as(), { slug: "api", position: 0 })).toMatchObject({ order: 0 });
    expect(await sections()).toEqual(["api(1)", "guides(1)"]);
    expect(await tree()).toEqual(["api:endpoints", "guides:basics"]);
    expect(await reading()).toEqual(["endpoints", "basics"]);
    expect((await collectionOptions(project.id)).map((c) => c.slug)).toEqual(["endpoints", "basics"]);

    expect(await call(updateSection, as(), { slug: "api", name: "API reference" })).toMatchObject({ slug: "api-reference", name: "API reference" });
    expect(await tree()).toEqual(["api-reference:endpoints", "guides:basics"]);
    await expect(call(updateSection, as(), { slug: "api", name: "Again" })).rejects.toMatchObject({ status: 404 });
  });

  test("deleting a section moves its collections last into the one before it (after it, for the first); the last one leaves none", async () => {
    await call(createSection, as(), { name: "Guides" });
    await collections("Basics");
    await call(createSection, as(), { name: "API" });
    await call(createCollection, as(), { name: "Endpoints", section: "api" });
    await call(createCollection, as(), { name: "Webhooks", section: "api" });
    await call(createCollection, as(), { name: "Signatures", parent: "webhooks" });
    await call(createSection, as(), { name: "SDKs" });

    expect(await call(deleteSection, as(), { slug: "api" })).toEqual({ deleted: "api", movedTo: "guides" });
    expect(await tree()).toEqual(["guides:basics", "guides:endpoints", "guides:webhooks", "guides:webhooks/signatures"]);
    expect(await call(deleteSection, as(), { slug: "guides" })).toEqual({ deleted: "guides", movedTo: "sdks" });
    expect(await tree()).toEqual(["sdks:basics", "sdks:endpoints", "sdks:webhooks", "sdks:webhooks/signatures"]);
    expect(await call(deleteSection, as(), { slug: "sdks" })).toEqual({ deleted: "sdks", movedTo: null });
    expect(await tree()).toEqual(["-:basics", "-:endpoints", "-:webhooks", "-:webhooks/signatures"]);
    expect(await sections()).toEqual([]);
  });

  test("deleting a collection brings the ones in it up into its place, in its section", async () => {
    await call(createSection, as(), { name: "Guides" });
    await call(createSection, as(), { name: "API" });
    for (const name of ["Endpoints", "Webhooks", "Errors"]) {
      await call(createCollection, as(), { name, section: "api" });
    }
    await call(createCollection, as(), { name: "Signatures", parent: "webhooks" });
    await call(createCollection, as(), { name: "Retries", parent: "webhooks" });
    await call(deleteCollection, as(), { slug: "webhooks" });
    expect(await tree()).toEqual(["api:endpoints", "api:signatures", "api:retries", "api:errors"]);
  });

  test("at the same time: one first section, the collections saved meanwhile in it, sections numbered one after the other", async () => {
    await collections("Basics");
    await Promise.all([
      call(createSection, as(), { name: "Guides" }),
      call(createSection, as(), { name: "API" }),
      call(createCollection, as(), { name: "Billing" }),
      call(createCollection, as(), { name: "Teams" }),
    ]);
    const listed = (await call(listSections, as(), {})).sections;
    expect(listed.map((s) => s.order)).toEqual([0, 1]);
    // Whichever section came first has them all, whether they were saved before it or after.
    expect(listed.map((s) => s.collections).sort()).toEqual([0, 3]);
    expect((await call(listCollections, as(), {})).collections.every((c) => c.section === listed.find((s) => s.collections === 3)!.slug)).toBe(true);
  });
});

describe("readers", () => {
  /** Guides (Basics, with Billing › Invoices) and API (Endpoints), an article in no collection, and an empty section. */
  async function sectioned() {
    await call(createSection, as(), { name: "Guides" });
    await call(createSection, as(), { name: "Empty" });
    await call(createSection, as(), { name: "API" });
    await call(createCollection, as(), { name: "Basics" });
    await call(createCollection, as(), { name: "Billing" });
    await call(createCollection, as(), { name: "Invoices", parent: "billing" });
    await call(createCollection, as(), { name: "Endpoints", section: "api" });
    await call(createCollection, as(), { name: "Unread", section: "empty" });
    for (const [title, collection] of [
      ["Start here", "basics"],
      ["Downloading invoices", "invoices"],
      ["Listing posts", "endpoints"],
      ["Contact us", null],
    ] as const) {
      const { slug } = await call(createArticle, as(), { title, body: `${title}.`, collection });
      await call(publishArticle, as(), { slug });
    }
    // Only a draft: Unread and its section have nothing to read.
    await call(createArticle, as(), { title: "Not yet", collection: "unread" });
  }

  test("the help center by section: those with something to read, the first with the articles in no collection", async () => {
    await sectioned();
    const help = await helpCenter(project.slug);
    expect(help.sections.map((s) => ({ slug: s.slug, collections: s.collections.map((c) => c.slug), uncollected: s.uncollected.map((a) => a.slug) }))).toEqual([
      { slug: "guides", collections: ["basics", "billing"], uncollected: ["contact-us"] },
      { slug: "api", collections: ["endpoints"], uncollected: [] },
    ]);
    expect(help.sections[0]!.collections[1]!.collections.map((c) => c.slug)).toEqual(["invoices"]);
    // All of it too, in reading order.
    expect(help.collections.map((c) => c.slug)).toEqual(["basics", "billing", "endpoints"]);

    // An article's way back is its section's tab (a collection in another: that one's section).
    expect((await publishedArticle(project.slug, "listing-posts"))?.section).toBe("api");
    expect((await publishedArticle(project.slug, "downloading-invoices"))?.section).toBe("guides");
    expect((await publishedArticle(project.slug, "contact-us"))?.section).toBeNull();
  });

  test("llms.txt has a heading per section with its collections a level down; the export a folder per section", async () => {
    await sectioned();
    const portal = `http://${project.slug}.localhost:3100`;
    const params = Promise.resolve({ project: project.slug });
    const text = await (await llms(new Request("http://x"), { params })).text();
    expect(text).toContain(
      [
        "## Guides",
        "### Basics",
        `- [Start here](${portal}/help/start-here.md)`,
        "### Billing",
        "#### Invoices",
        `- [Downloading invoices](${portal}/help/downloading-invoices.md)`,
        "### More articles",
        `- [Contact us](${portal}/help/contact-us.md)`,
        "## API",
        "### Endpoints",
        `- [Listing posts](${portal}/help/listing-posts.md)`,
        "## Changelog",
      ].join("\n\n"),
    );
    expect(text).not.toContain("Empty");

    actAs(owner);
    const files = unzipSync(new Uint8Array(await (await exportZip(new Request("http://x"), { params })).arrayBuffer()));
    expect(Object.keys(files).filter((file) => file.startsWith("help/")).sort()).toEqual([
      "help/api/endpoints/listing-posts.md",
      "help/contact-us.md",
      "help/empty/unread/not-yet.md",
      "help/guides/basics/start-here.md",
      "help/guides/billing/invoices/downloading-invoices.md",
    ]);
    expect(strFromU8(files["help/api/endpoints/listing-posts.md"]!)).toContain('section: "API"');
  });
});
