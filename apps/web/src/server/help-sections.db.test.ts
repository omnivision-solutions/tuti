import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, test } from "vitest";

import { GET as exportZip } from "@/app/app/[project]/settings/export/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { collectionOptions, docsContents, publishedArticle } from "./help-queries";
import {
  createArticle,
  createCollection,
  createTab,
  deleteCollection,
  deleteTab,
  listCollections,
  listTabs,
  publishArticle,
  reorderCollection,
  reorderTab,
  updateCollection,
  updateTab,
} from "./operations/help";
import { call } from "./operations/run";

/**
 * Docs tabs: once there's one, every top-level collection is in one, the
 * ones inside others are in their parent's, and every list is by tab, then by order there.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
/** Collections in reading order, as `tab:parent/slug`. */
const tree = async () =>
  (await call(listCollections, as(), {})).collections.map((c) => `${c.tab ?? "-"}:${c.parent ? `${c.parent}/` : ""}${c.slug}`);
const tabs = async () => (await call(listTabs, as(), {})).tabs.map((s) => `${s.slug}(${s.collections})`);
const collections = (...names: string[]) => names.reduce((done, name) => done.then(() => call(createCollection, as(), { name })), Promise.resolve({}));
const refused = { status: 400, code: "invalid_input" };

describe("tabs", () => {
  test("without tabs, collections are in none; the first tab takes every top-level one, and the ones in them follow", async () => {
    await collections("Basics", "Billing");
    await call(createCollection, as(), { name: "Invoices", parent: "billing" });
    expect(await tree()).toEqual(["-:basics", "-:billing", "-:billing/invoices"]);
    expect(await tabs()).toEqual([]);

    expect(await call(createTab, as(), { name: "Guides" })).toMatchObject({ slug: "guides", name: "Guides", order: 0, collections: 2 });
    expect(await tree()).toEqual(["guides:basics", "guides:billing", "guides:billing/invoices"]);
    // A second one starts empty.
    expect(await call(createTab, as(), { name: "API" })).toMatchObject({ slug: "api", order: 1, collections: 0 });
    expect(await tabs()).toEqual(["guides(2)", "api(0)"]);
  });

  test("a new top-level collection goes last in the tab named, or the first; one inside another has its tab", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(createTab, as(), { name: "API" });
    await collections("Basics");
    expect(await call(createCollection, as(), { name: "Endpoints", tab: "api" })).toMatchObject({ tab: "api", order: 0 });
    expect(await call(createCollection, as(), { name: "Webhooks", tab: "api" })).toMatchObject({ tab: "api", order: 1 });
    expect(await call(createCollection, as(), { name: "Signatures", parent: "webhooks" })).toMatchObject({ tab: "api", parent: "webhooks" });
    expect(await tree()).toEqual(["guides:basics", "api:endpoints", "api:webhooks", "api:webhooks/signatures"]);

    await expect(call(createCollection, as(), { name: "Nope", tab: "nope" })).rejects.toMatchObject({ ...refused, message: "There's no tab “nope”" });
    await expect(call(createCollection, as(), { name: "Nope", parent: "webhooks", tab: "guides" })).rejects.toMatchObject(refused);
  });

  test("collections move to another tab (last, or at a place), with the ones in them; one coming out of another stays in its tab", async () => {
    await call(createTab, as(), { name: "Guides" });
    await collections("Basics", "Billing", "Teams");
    await call(createCollection, as(), { name: "Invoices", parent: "billing" });
    await call(createTab, as(), { name: "API" });
    await call(createCollection, as(), { name: "Endpoints", tab: "api" });

    expect(await call(reorderCollection, as(), { slug: "billing", tab: "api", position: 0 })).toMatchObject({ tab: "api", order: 0 });
    expect(await tree()).toEqual(["guides:basics", "guides:teams", "api:billing", "api:billing/invoices", "api:endpoints"]);
    // updateCollection moves it last there.
    expect(await call(updateCollection, as(), { slug: "teams", tab: "api" })).toMatchObject({ tab: "api", order: 2 });
    // Out of Billing, to the top level: in Billing's tab, unless another is named.
    expect(await call(reorderCollection, as(), { slug: "invoices", parent: null })).toMatchObject({ tab: "api", parent: null });
    await call(reorderCollection, as(), { slug: "invoices", parent: "billing" });
    expect(await call(reorderCollection, as(), { slug: "invoices", parent: null, tab: "guides", position: 0 })).toMatchObject({ tab: "guides" });
    expect(await tree()).toEqual(["guides:invoices", "guides:basics", "api:billing", "api:endpoints", "api:teams"]);
    // Into a collection in another tab: it's in that one's now.
    expect(await call(reorderCollection, as(), { slug: "basics", parent: "endpoints" })).toMatchObject({ tab: "api", parent: "endpoints" });

    await expect(call(reorderCollection, as(), { slug: "basics", tab: "guides" })).rejects.toMatchObject({
      ...refused,
      message: "A collection inside another is in that one's tab, so it can't have its own",
    });
    await expect(call(reorderCollection, as(), { slug: "teams", tab: "nope" })).rejects.toMatchObject(refused);
  });

  test("tabs are reordered and renamed, and every list follows: readers, the editor's picker, collections.list", async () => {
    await call(createTab, as(), { name: "Guides" });
    await collections("Basics");
    await call(createTab, as(), { name: "API" });
    await call(createCollection, as(), { name: "Endpoints", tab: "api" });
    for (const [title, collection] of [
      ["Start here", "basics"],
      ["List posts", "endpoints"],
    ]) {
      const { slug } = await call(createArticle, as(), { title, body: `${title}.`, collection });
      await call(publishArticle, as(), { slug });
    }
    const reading = async () => (await docsContents(project.slug)).collections.map((c) => c.slug);
    expect(await reading()).toEqual(["basics", "endpoints"]);

    expect(await call(reorderTab, as(), { slug: "api", position: 0 })).toMatchObject({ order: 0 });
    expect(await tabs()).toEqual(["api(1)", "guides(1)"]);
    expect(await tree()).toEqual(["api:endpoints", "guides:basics"]);
    expect(await reading()).toEqual(["endpoints", "basics"]);
    expect((await collectionOptions(project.id)).map((c) => c.slug)).toEqual(["endpoints", "basics"]);

    expect(await call(updateTab, as(), { slug: "api", name: "API reference" })).toMatchObject({ slug: "api-reference", name: "API reference" });
    expect(await tree()).toEqual(["api-reference:endpoints", "guides:basics"]);
    await expect(call(updateTab, as(), { slug: "api", name: "Again" })).rejects.toMatchObject({ status: 404 });
  });

  test("deleting a tab moves its collections last into the one before it (after it, for the first); the last one leaves none", async () => {
    await call(createTab, as(), { name: "Guides" });
    await collections("Basics");
    await call(createTab, as(), { name: "API" });
    await call(createCollection, as(), { name: "Endpoints", tab: "api" });
    await call(createCollection, as(), { name: "Webhooks", tab: "api" });
    await call(createCollection, as(), { name: "Signatures", parent: "webhooks" });
    await call(createTab, as(), { name: "SDKs" });

    expect(await call(deleteTab, as(), { slug: "api" })).toEqual({ deleted: "api", movedTo: "guides" });
    expect(await tree()).toEqual(["guides:basics", "guides:endpoints", "guides:webhooks", "guides:webhooks/signatures"]);
    expect(await call(deleteTab, as(), { slug: "guides" })).toEqual({ deleted: "guides", movedTo: "sdks" });
    expect(await tree()).toEqual(["sdks:basics", "sdks:endpoints", "sdks:webhooks", "sdks:webhooks/signatures"]);
    expect(await call(deleteTab, as(), { slug: "sdks" })).toEqual({ deleted: "sdks", movedTo: null });
    expect(await tree()).toEqual(["-:basics", "-:endpoints", "-:webhooks", "-:webhooks/signatures"]);
    expect(await tabs()).toEqual([]);
  });

  test("deleting a collection brings the ones in it up into its place, in its tab", async () => {
    await call(createTab, as(), { name: "Guides" });
    await call(createTab, as(), { name: "API" });
    for (const name of ["Endpoints", "Webhooks", "Errors"]) {
      await call(createCollection, as(), { name, tab: "api" });
    }
    await call(createCollection, as(), { name: "Signatures", parent: "webhooks" });
    await call(createCollection, as(), { name: "Retries", parent: "webhooks" });
    await call(deleteCollection, as(), { slug: "webhooks" });
    expect(await tree()).toEqual(["api:endpoints", "api:signatures", "api:retries", "api:errors"]);
  });

  test("at the same time: one first tab, the collections saved meanwhile in it, tabs numbered one after the other", async () => {
    await collections("Basics");
    await Promise.all([
      call(createTab, as(), { name: "Guides" }),
      call(createTab, as(), { name: "API" }),
      call(createCollection, as(), { name: "Billing" }),
      call(createCollection, as(), { name: "Teams" }),
    ]);
    const listed = (await call(listTabs, as(), {})).tabs;
    expect(listed.map((s) => s.order)).toEqual([0, 1]);
    // Whichever tab came first has them all, whether they were saved before it or after.
    expect(listed.map((s) => s.collections).sort()).toEqual([0, 3]);
    expect((await call(listCollections, as(), {})).collections.every((c) => c.tab === listed.find((s) => s.collections === 3)!.slug)).toBe(true);
  });
});

describe("readers", () => {
  /** Guides (Basics, with Billing › Invoices) and API (Endpoints), an article in no collection, and an empty tab. */
  async function withTabs() {
    await call(createTab, as(), { name: "Guides" });
    await call(createTab, as(), { name: "Empty" });
    await call(createTab, as(), { name: "API" });
    await call(createCollection, as(), { name: "Basics" });
    await call(createCollection, as(), { name: "Billing" });
    await call(createCollection, as(), { name: "Invoices", parent: "billing" });
    await call(createCollection, as(), { name: "Endpoints", tab: "api" });
    await call(createCollection, as(), { name: "Unread", tab: "empty" });
    for (const [title, collection] of [
      ["Start here", "basics"],
      ["Downloading invoices", "invoices"],
      ["Listing posts", "endpoints"],
      ["Contact us", null],
    ] as const) {
      const { slug } = await call(createArticle, as(), { title, body: `${title}.`, collection });
      await call(publishArticle, as(), { slug });
    }
    // Only a draft: Unread and its tab have nothing to read.
    await call(createArticle, as(), { title: "Not yet", collection: "unread" });
  }

  test("the docs by tab: those with something to read, the first with the articles in no collection", async () => {
    await withTabs();
    const help = await docsContents(project.slug);
    expect(help.tabs.map((s) => ({ slug: s.slug, collections: s.collections.map((c) => c.slug), uncollected: s.uncollected.map((a) => a.slug) }))).toEqual([
      { slug: "guides", collections: ["basics", "billing"], uncollected: ["contact-us"] },
      { slug: "api", collections: ["endpoints"], uncollected: [] },
    ]);
    expect(help.tabs[0]!.collections[1]!.collections.map((c) => c.slug)).toEqual(["invoices"]);
    // All of it too, in reading order.
    expect(help.collections.map((c) => c.slug)).toEqual(["basics", "billing", "endpoints"]);

    // An article's way back is its tab (a collection in another's: that one's tab).
    expect((await publishedArticle(project.slug, "listing-posts"))?.tab).toBe("api");
    expect((await publishedArticle(project.slug, "downloading-invoices"))?.tab).toBe("guides");
    expect((await publishedArticle(project.slug, "contact-us"))?.tab).toBeNull();
  });

  test("llms.txt has a heading per tab with its collections a level down; the export a folder per tab", async () => {
    await withTabs();
    const portal = `http://${project.slug}.localhost:3100`;
    const params = Promise.resolve({ project: project.slug });
    const text = await (await llms(new Request("http://x"), { params })).text();
    expect(text).toContain(
      [
        "## Guides",
        "### Basics",
        `- [Start here](${portal}/docs/start-here.md)`,
        "### Billing",
        "#### Invoices",
        `- [Downloading invoices](${portal}/docs/downloading-invoices.md)`,
        "### More articles",
        `- [Contact us](${portal}/docs/contact-us.md)`,
        "## API",
        "### Endpoints",
        `- [Listing posts](${portal}/docs/listing-posts.md)`,
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
