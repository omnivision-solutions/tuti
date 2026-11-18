import { type NoAccess, prisma, type ReadAccess } from "@tuti/db";
import type { ApiDoc } from "@tuti/shared/api-reference";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, test } from "vitest";

import DocsOperationPage, { generateMetadata } from "@/app/portal/[project]/(site)/docs/[slug]/[operation]/page";
import DocsSlugPage from "@/app/portal/[project]/(site)/docs/[slug]/page";
import { GET as shareImage } from "@/app/portal/[project]/(site)/og/[[...path]]/route";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";

import { apiReferencePage, markdownDoc } from "./api-reference-queries";
import { createApiReference, updateApiReference } from "./operations/api-references";
import { createArticle, createCollection, createTab, publishArticle } from "./operations/docs";
import { call } from "./operations/run";

/**
 * The portal's page for an API reference's operation: only what's on the help center has one, for
 * whoever may read the reference's tab, as an article in that tab.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

/** In the operations' descriptions and fields and nowhere else: whatever has it shows what an operation says. */
const SECRET = "zebra";

const SPEC = `
openapi: 3.1.0
info: { title: Acme API, version: "1" }
servers: [{ url: /v1 }]
components:
  securitySchemes:
    key: { type: http, scheme: bearer }
security: [{ key: [] }]
paths:
  /posts/{number}:
    get:
      tags: [Posts]
      summary: Get a post
      description: "Reads a **${SECRET}** post.\\n\\n<script>alert('pwned')</script><img src=x onerror=alert(1)>"
      parameters:
        - { name: number, in: path, required: true, description: The ${SECRET} number, schema: { type: integer, minimum: 1 } }
        - { name: expand, in: query, schema: { type: string, enum: [author, votes], default: author } }
      responses:
        "200":
          description: The post
          content:
            application/json:
              schema: { type: object, properties: { title: { type: string }, author: { type: object, properties: { name: { type: string } } } } }
              example: { title: "Dark ${SECRET} mode" }
        "404": { description: No such post }
  /posts:
    post:
      tags: [Posts]
      summary: Create a post
      security: [{}, { key: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, required: [title], properties: { title: { type: string, description: What the ${SECRET} asks } } }
      responses: { "201": { description: Created } }
  /admin/purge:
    delete:
      tags: [Admin]
      summary: Purge
      security: []
      responses: { "204": { description: Gone } }
`;

/** Its own reference ("Tags"): a way of signing the reference can't describe, and a body and a response that aren't objects. */
const TAGS = `
openapi: 3.1.0
info: { title: Tags API, version: "1" }
components:
  securitySchemes:
    key: { type: http, scheme: bearer }
    mtls: { type: mutualTLS }
paths:
  /tags:
    put:
      tags: [Posts]
      summary: Set the tags
      security: [{ key: [], mtls: [] }]
      requestBody:
        content:
          application/json:
            schema: { type: array, description: Every ${SECRET} tag, maxItems: 5, default: [bug], items: { type: string, enum: [bug, idea], maxLength: 20 } }
      responses:
        "200":
          description: "How it **went**, see [limits](https://acme.example/limits)"
          content:
            text/plain:
              schema: { type: string, description: The ${SECRET} outcome, enum: [saved, unchanged], default: saved }
              example: saved
        "202":
          description: Taken
          content: { application/json: { schema: { type: string }, example: accepted } }
        "204": { description: "Nothing **changed**" }
    get:
      tags: [Posts]
      summary: List the tags
      security: [{ key: [], mtls: [] }, { key: [] }]
      parameters:
        - { name: kinds, in: query, schema: { type: array, items: { type: string, description: A ${SECRET} kind, enum: [open, done], minLength: 2 } } }
      responses:
        "200":
          description: The tags
          content:
            application/json:
              schema: { type: object, description: One ${SECRET} page of them, default: { total: 0 }, properties: { total: { type: integer } } }
`;
const addTags = () => call(createApiReference, as(), { name: "Tags", spec: TAGS, tab: "api" });

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

/** Two tabs, Guides (first, with an article) and API, with the reference in API. */
beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  await call(createTab, as(), { name: "Guides" });
  await call(createTab, as(), { name: "API" });
  await call(createCollection, as(), { name: "Basics", tab: "guides" });
  const { slug } = await call(createArticle, as(), { title: "Getting started", body: "Hello.", collection: "basics" });
  await call(publishArticle, as(), { slug });
  await call(createApiReference, as(), { name: "Reference", spec: SPEC, tab: "api" });
  actAs(null);
});

const setTab = (access: ReadAccess, noAccess: NoAccess = "INHERIT") =>
  prisma.docsTab.update({ where: { projectId_slug: { projectId: project.id, slug: "api" } }, data: { access, noAccess } });

const params = (operation: string, slug = "reference") => ({ params: Promise.resolve({ project: project.slug, slug, operation }) }) as never;

/** A server component's output with the server components in it rendered too; a client component stays as its name and props. */
async function rendered(node: ReactNode): Promise<unknown> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child: ReactNode) => rendered(child)));
  }
  if (!isValidElement(node)) {
    return node;
  }
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (typeof type === "function") {
    try {
      return await rendered(await (type as (props: object) => ReactNode | Promise<ReactNode>)(props));
    } catch {
      // A client component: its props.
    }
  }
  return { component: typeof type === "function" ? type.name : type, props: { ...props, children: await rendered(props.children as ReactNode) } };
}

/** All an operation's page sends this reader, and its metadata, as one string. */
async function pageText(operation: string, slug?: string) {
  // Each object once: props can share, or loop back to, objects.
  const seen = new WeakSet();
  return JSON.stringify([await rendered(await DocsOperationPage(params(operation, slug))), await generateMetadata(params(operation, slug))], (_, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return undefined;
      }
      seen.add(value);
    }
    return value;
  });
}

/** The status of an operation's link card. */
const card = async (operation: string) =>
  (await shareImage(new Request("http://x"), { params: Promise.resolve({ project: project.slug, path: ["docs", "reference", operation] }) })).status;

/** Whether the page is "not found". */
const missing = async (operation: string, slug?: string) =>
  ((await DocsOperationPage(params(operation, slug)).then(
    () => null,
    (error: { digest?: string }) => error.digest,
  )) ?? "").startsWith("NEXT_HTTP_ERROR_FALLBACK;404");

describe("an operation's page", () => {
  test("shows a published reference's operation to everyone: its method and path, parameters, examples and its tab's tree", async () => {
    const page = await apiReferencePage(project.slug, "reference");
    expect(page).toMatchObject({ kind: "reference", tab: "api", restricted: false, reference: { name: "Reference", treeStyle: "FOLDERS" }, references: [{ slug: "reference" }] });
    expect(page?.operations.map((o) => o.slug)).toEqual(["get-a-post", "create-a-post", "purge"]);
    const text = await pageText("get-a-post");
    for (const shown of ["Get a post", "/posts/", "{number}", "Path parameters", "Query parameters", "expand", "at least 1", "Bearer token", "No such post", "curl ", "import requests", `Dark ${SECRET} mode`, "Create a post", "Admin"]) {
      expect(text).toContain(shown);
    }
    // A server without a host: the placeholder's, until the team says where the API is.
    expect(text).toContain("https://api.example.com/v1/posts/1");
    expect(await generateMetadata(params("get-a-post"))).toMatchObject({
      title: "Get a post · Reference",
      alternates: { canonical: expect.stringMatching(/\/docs\/reference\/get-a-post$/) },
    });
    expect((await generateMetadata(params("get-a-post"))).robots).toBeUndefined();
    expect(await card("get-a-post")).toBe(200);
    expect(await card("no-such-operation")).toBe(404);
  });

  test("renders the spec's Markdown as content, never as markup", async () => {
    const text = await pageText("get-a-post");
    expect(text).toContain(`{"component":"strong","props":{"children":"${SECRET}"}}`);
    for (const markup of ["dangerouslySetInnerHTML", "pwned", "onerror", "<script"]) {
      expect(text).not.toContain(markup);
    }
    // A plain sentence is a paragraph as it is.
    expect(await markdownDoc("Plain words, 3-200 characters.")).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plain words, 3-200 characters." }] }] });
    expect(JSON.stringify(await markdownDoc("- one\n- two"))).toContain("bulletList");
    // A wrapped line is its paragraph going on, as Markdown has it; an address goes to the parser, and is a link.
    expect(await markdownDoc("Wrapped by\nthe spec.\n\nNext.")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Wrapped by the spec." }] },
        { type: "paragraph", content: [{ type: "text", text: "Next." }] },
      ],
    });
    expect(JSON.stringify(await markdownDoc("See https://acme.example/docs for more."))).toContain('"href":"https://acme.example/docs"');
    // So do an email address, and two spaces at a line's end: a line break.
    expect(JSON.stringify(await markdownDoc("Write to help@acme.example for more."))).toContain('"href":"mailto:help@acme.example"');
    expect(JSON.stringify(await markdownDoc("First line  \nsecond line"))).toContain('"type":"hardBreak"');
  });

  test("says how it's signed: the scheme, and that unsigned works too when the spec says so", async () => {
    const signed = await pageText("get-a-post");
    expect(signed).toContain('"Bearer token"');
    expect(signed).not.toContain(", or none");
    const optional = await pageText("create-a-post");
    expect(optional).toContain('"Bearer token"');
    expect(optional).toContain(", or none");
    // A way that needs a scheme the reference can't describe isn't named by the rest of it: the token alone isn't enough.
    await addTags();
    const partly = await pageText("set-the-tags", "tags");
    expect(partly).toContain("/tags");
    expect(partly).not.toContain("Authorization");
    expect(partly).not.toContain("Bearer token");
    // Another way that's all known is still shown, alone.
    const either = await pageText("list-the-tags", "tags");
    expect(either).toContain('"Bearer token"');
    expect(either).not.toContain('" or "');
    // The same for a doc that names a scheme the reference doesn't have (the reader drops such a way; a doc from elsewhere may not).
    const row = await prisma.apiReference.findFirstOrThrow({ where: { projectId: project.id, slug: "tags" }, select: { id: true, doc: true } });
    const doc = row.doc as unknown as ApiDoc;
    doc.operations.find((o) => o.slug === "list-the-tags")!.auth = [["key", "ghost"]];
    await prisma.apiReference.update({ where: { id: row.id }, data: { doc: doc as never } });
    const half = await pageText("list-the-tags", "tags");
    expect(half).toContain("/tags");
    expect(half).not.toContain("Bearer token");
    // (The request example still sends the key: it's one of what the way needs.)
    expect(half).not.toContain('"children":"Authorization"');
    // None listed: it needs none, or one the reference doesn't show, so the page says nothing either way.
    const unlisted = await pageText("purge");
    expect(unlisted).toContain("/admin/purge");
    expect(unlisted).not.toContain("Authorization");
  });

  test("sends examples to the team's base address when the spec's server has no host", async () => {
    await call(updateApiReference, as(), { slug: "reference", baseUrl: "https://acme.test" });
    const text = await pageText("get-a-post");
    expect(text).toContain("https://acme.test/v1/posts/1");
    expect(text).not.toContain("api.example.com");
  });

  test("is a 404 for a hidden operation, one in a hidden group, an unknown slug and an unpublished reference", async () => {
    await call(updateApiReference, as(), { slug: "reference", hide: ["POST /posts"], hideGroups: ["Admin"] });
    expect((await apiReferencePage(project.slug, "reference"))?.operations.map((o) => o.slug)).toEqual(["get-a-post"]);
    expect(await missing("create-a-post")).toBe(true);
    expect(await missing("purge")).toBe(true);
    expect(await missing("no-such-operation")).toBe(true);
    expect(await missing("get-a-post", "no-such-reference")).toBe(true);
    expect(await missing("get-a-post")).toBe(false);
    // What's hidden isn't in the tree either.
    const text = await pageText("get-a-post");
    expect(text).not.toContain("Create a post");
    expect(text).not.toContain("Purge");
    // The team too: the portal shows what readers get.
    actAs(owner);
    expect(await missing("create-a-post")).toBe(true);
    await call(updateApiReference, as(), { slug: "reference", published: false });
    expect(await apiReferencePage(project.slug, "reference")).toBeNull();
    expect(await missing("get-a-post")).toBe(true);
  });

  test("a reference with every operation hidden is a 404", async () => {
    await call(updateApiReference, as(), { slug: "reference", hideGroups: ["Posts", "Admin"] });
    expect(await apiReferencePage(project.slug, "reference")).toBeNull();
  });

  test("the reference's own address goes to its first operation on the help center", async () => {
    const slugPage = (slug: string) => DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug }) } as never);
    expect(await redirectTarget(slugPage("reference"))).toBe("/docs/reference/get-a-post");
    await call(updateApiReference, as(), { slug: "reference", hide: ["GET /posts/{}"] });
    expect(await redirectTarget(slugPage("reference"))).toBe("/docs/reference/create-a-post");
    await setTab("SIGNED_IN");
    // Not for this visitor: a 404, not a redirect, a page or an error of another kind.
    await expect(slugPage("reference")).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) });
  });
});

describe("a body or response that isn't an object", () => {
  test("shows what its own schema says: an array's item type, limits and allowed values, a plain value's description, default and allowed values", async () => {
    await addTags();
    const text = await pageText("set-the-tags", "tags");
    // The body: an array of strings, each one of two.
    for (const shown of ["application/json · array of string · at most 5 items", `Every ${SECRET} tag`, '"Default: "', '[\\"bug\\"]', "Each item: ", "at most 20 characters", '"Each item one of"', '\\"idea\\"']) {
      expect(text).toContain(shown);
    }
    // A field that's such an array says the same of its items, and an object says what it is over its fields.
    const list = await pageText("list-the-tags", "tags");
    for (const shown of ['"children":"kinds"', "array of string", "Each item: ", "at least 2 characters", `A ${SECRET} kind`, '"Each item one of"', '\\"done\\"', `One ${SECRET} page of them`, '{\\"total\\":0}', '"children":"total"']) {
      expect(list).toContain(shown);
    }
    // The response: a plain string, one of two.
    for (const shown of ["text/plain · string", `The ${SECRET} outcome`, '"One of"', '\\"saved\\"', '\\"unchanged\\"']) {
      expect(text).toContain(shown);
    }
  });
});

describe("a response", () => {
  test("has its description's Markdown rendered: words alone in a row that opens, the link once it's open; and its example as its content type sends it", async () => {
    await addTags();
    const text = await pageText("set-the-tags", "tags");
    expect(text).not.toContain("**");
    // A row that opens: no link inside its toggle, the whole description under it.
    expect(text).toContain('"children":"How it went, see limits"');
    expect(text).toContain('"href":"https://acme.example/limits"');
    // One that doesn't: rendered where it is.
    expect(text).toContain('{"component":"strong","props":{"children":"changed"}}');
    // A string is text under text/plain, and JSON (in its quotes) under application/json.
    expect(text).toContain('"text":"saved"');
    expect(text).toContain('"text":"\\"accepted\\""');
  });
});

describe("the tree", () => {
  test("lists the groups in the team's order, and the reference's own address opens the first operation listed", async () => {
    await call(updateApiReference, as(), { slug: "reference", groupOrder: ["Admin", "Posts"] });
    expect((await apiReferencePage(project.slug, "reference"))?.operations.map((o) => o.slug)).toEqual(["purge", "get-a-post", "create-a-post"]);
    expect(await redirectTarget(DocsSlugPage({ params: Promise.resolve({ project: project.slug, slug: "reference" }) } as never))).toBe("/docs/reference/purge");
    const text = await pageText("get-a-post");
    expect(text.indexOf('"children":"Admin"')).toBeGreaterThan(-1);
    expect(text.indexOf('"children":"Admin"')).toBeLessThan(text.indexOf('"children":"Posts"'));
  });

  test("sits as the team set it: groups as folders, as headings, or the reference as one entry; the tab's other references are a link each", async () => {
    await call(createApiReference, as(), { name: "Webhooks", spec: SPEC, tab: "api" });
    await call(createApiReference, as(), { name: "Draft API", spec: SPEC, tab: "api" });
    await call(updateApiReference, as(), { slug: "draft-api", published: false });
    await call(createApiReference, as(), { name: "Elsewhere", spec: SPEC, tab: "guides" });
    const folder = '"component":"details","props":{"open":true,"className":"group/collection","children":[{"component":"summary"';
    const heading = '"role":"group","aria-label":"Posts"';
    const folders = await pageText("get-a-post");
    expect(folders).toContain(folder);
    expect(folders).not.toContain(heading);
    // The tab's other published reference by name, at its own address; no draft, and none of another tab's.
    expect(folders).toContain('"href":"/docs/webhooks","title":"Webhooks"');
    expect(folders).not.toContain("Draft API");
    expect(folders).not.toContain("Elsewhere");
    await call(updateApiReference, as(), { slug: "reference", treeStyle: "headings" });
    const headings = await pageText("get-a-post");
    expect(headings).toContain(heading);
    expect(headings).not.toContain(folder);
    expect(headings).toContain('"href":"/docs/reference/purge"');
    await call(updateApiReference, as(), { slug: "reference", treeStyle: "entry" });
    const entry = await pageText("get-a-post");
    // One folder, the reference's, open on its own pages, with the groups as headings in it.
    expect(entry).toContain(`${folder},"props":{"className":"flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 font-medium hover:bg-muted [&::-webkit-details-marker]:hidden","children":[{"component":"span","props":{"className":"min-w-0 break-words","children":"Reference"}}`);
    expect(entry).toContain(heading);
  });

  test("has its tab's collections, and none of another tab's when its own has nothing else to read", async () => {
    // API has the reference alone: no collection of Guides' beside it.
    expect(await pageText("get-a-post")).not.toContain("Basics");
    await call(createCollection, as(), { name: "Concepts", tab: "api" });
    const { slug } = await call(createArticle, as(), { title: "Keys", body: "Hello.", collection: "concepts" });
    await call(publishArticle, as(), { slug });
    const text = await pageText("get-a-post");
    expect(text).toContain("Concepts");
    expect(text).not.toContain("Basics");
    // In no tab: the first tab's.
    await prisma.apiReference.updateMany({ where: { projectId: project.id }, data: { tabId: null } });
    const loose = await pageText("get-a-post");
    expect(loose).toContain("Basics");
    expect(loose).not.toContain("Concepts");
  });
});

describe("a GraphQL reference", () => {
  test("has the plain page: the field's arguments, and the query to send in the examples", async () => {
    await call(createApiReference, as(), {
      name: "Graph",
      spec: `type Query {\n  "A ${SECRET} by its id."\n  post(id: ID!): Post\n}\ntype Post {\n  id: ID!\n  title: String\n}\n`,
      tab: "api",
    });
    const page = await apiReferencePage(project.slug, "graph");
    expect(page).toMatchObject({ kind: "reference", doc: { format: "graphql" }, operations: [{ slug: "post", kind: "query" }] });
    const text = await pageText("post", "graph");
    const metadata = await generateMetadata(params("post", "graph"));
    expect(metadata).toMatchObject({ title: "post · Graph" });
    for (const shown of [`A ${SECRET} by its id.`, "Arguments", '"children":"id"', "ID!", "query", "curl ", "post(id: $id)"]) {
      expect(text).toContain(shown);
    }
    // No method beside its name in the tree, no signing line and no status rows: those are OpenAPI's.
    for (const absent of ['"aria-label":"Responses"', "Authorization", "text-status-planned"]) {
      expect(text).not.toContain(absent);
    }
  });
});

describe("in a tab for some readers only", () => {
  test("it's a 404 for a visitor the tab isn't for, and read by those it's for and the team", async () => {
    await setTab("SIGNED_IN");
    expect(await apiReferencePage(project.slug, "reference")).toBeNull();
    expect(await missing("get-a-post")).toBe(true);
    expect(await generateMetadata(params("get-a-post"))).toEqual({});
    expect(await card("get-a-post")).toBe(404);
    actAs(await signUp("Reader"));
    expect(await apiReferencePage(project.slug, "reference")).toMatchObject({ kind: "reference", restricted: true });
    expect(await pageText("get-a-post")).toContain(SECRET);
    // Not for search engines: not everyone may read it.
    expect(await generateMetadata(params("get-a-post"))).toMatchObject({ robots: { index: false } });
    // For a group nobody is in: the team's only.
    await setTab("GROUPS");
    expect(await missing("get-a-post")).toBe(true);
    actAs(owner);
    expect(await pageText("get-a-post")).toContain(SECRET);
  });

  test("a tab that shows what's in it with a lock: the operation's title and what to do, nothing it says", async () => {
    await setTab("SIGNED_IN", "LOCK");
    expect(await apiReferencePage(project.slug, "reference")).toEqual({
      kind: "locked",
      reference: { slug: "reference", name: "Reference" },
      tab: "api",
      operations: [
        { slug: "get-a-post", title: "Get a post" },
        { slug: "create-a-post", title: "Create a post" },
        { slug: "purge", title: "Purge" },
      ],
      signedIn: false,
    });
    const text = await pageText("get-a-post");
    expect(text).toContain("Get a post");
    expect(text).toContain("Sign in to read this.");
    for (const kept of [SECRET, "/posts", "curl", "Create a post", "Bearer"]) {
      expect(text).not.toContain(kept);
    }
    expect(await generateMetadata(params("get-a-post"))).toMatchObject({ title: "Get a post · Reference", robots: { index: false } });
    expect(await missing("no-such-operation")).toBe(true);
    // Signed in, and still not for them (a group nobody is in).
    await setTab("GROUPS", "LOCK");
    actAs(await signUp("Stranger"));
    const stranger = await pageText("get-a-post");
    expect(stranger).toContain("You don't have access to this.");
    expect(stranger).not.toContain(SECRET);
  });

  test("a reference in no tab is under the first, as an article in no collection is", async () => {
    await prisma.apiReference.updateMany({ where: { projectId: project.id }, data: { tabId: null } });
    expect(await apiReferencePage(project.slug, "reference")).toMatchObject({ kind: "reference", tab: null });
    await prisma.docsTab.update({ where: { projectId_slug: { projectId: project.id, slug: "guides" } }, data: { access: "SIGNED_IN" } });
    expect(await apiReferencePage(project.slug, "reference")).toBeNull();
  });
});
