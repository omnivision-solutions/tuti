import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

const SPEC = `
openapi: 3.1.0
info: { title: Acme API, version: "1" }
servers: [{ url: https://api.acme.example/v1 }]
components:
  securitySchemes:
    key: { type: http, scheme: bearer }
  schemas:
    Post:
      type: object
      properties:
        number: { type: integer }
        title: { type: string }
        author: { type: object, properties: { name: { type: string, description: Their display name. } } }
security: [{ key: [] }]
paths:
  /posts:
    get:
      tags: [Posts]
      summary: List posts
      parameters:
        - { name: board, in: query, description: Only this board's posts., schema: { type: string } }
      responses:
        "200": { description: The posts, content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/Post" } } } } }
    post:
      tags: [Posts]
      summary: Create a post
      description: Adds a post to a board. The post starts in the board's **first status**.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [board, title]
              properties:
                board: { type: string, description: "The board's slug, such as \`ideas\`." }
                title: { type: string, minLength: 3, maxLength: 200, description: What the post asks. }
                status: { type: string, enum: [open, planned], default: open }
            example: { board: ideas, title: Dark mode for the editor }
      responses:
        "201":
          description: The new post
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Post" }
              example: { number: 128, title: Dark mode for the editor }
        "400":
          description: The body isn't valid
          content: { application/json: { schema: { type: object, properties: { error: { type: string } } }, example: { error: Title is required } } }
  /posts/{number}:
    delete:
      tags: [Posts]
      summary: Delete a post
      deprecated: true
      parameters:
        - { name: number, in: path, required: true, description: The post's number., schema: { type: integer, minimum: 1 } }
      responses: { "204": { description: Deleted } }
  /internal/purge:
    post:
      tags: [Internal]
      summary: Purge everything
      responses: { "204": { description: Gone } }
`;

test("a reader opens an API reference's operation: its method, path and fields, the request in three languages and the responses' examples", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Two tabs, each with something to read; the reference goes in the second, after its collection.
  for (const [tab, collection, title] of [
    ["Guides", "Getting started", "Welcome"],
    ["API", "Introduction", "Authentication"],
  ] as const) {
    const { slug: tabSlug } = await api("/tabs", { name: tab });
    const { slug: collectionSlug } = await api("/collections", { name: collection, tab: tabSlug });
    const { slug: article } = await api("/articles", { title, body: `About ${title.toLowerCase()}.`, collection: collectionSlug });
    await api(`/articles/${article}/publish`, {});
  }
  await api("/api-references", { name: "Reference", spec: SPEC, tab: "api" });
  // What the team takes off the help center has no page.
  await api("/api-references/reference", { hideGroups: ["Internal"] }, "PATCH");

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  // The reference's own address is its first operation's, until it has a page of its own.
  await reader.goto("/docs/reference");
  await expect(reader).toHaveURL(/\/docs\/reference\/list-posts$/);
  await expect(reader.getByRole("heading", { name: "List posts", level: 1 })).toBeVisible();
  // Its tab is the open one, and the tree has the tab's collection, then the reference's groups with each operation's method.
  await expect(reader.getByRole("navigation", { name: "Docs tabs" }).getByRole("link", { name: "API", exact: true })).toHaveAttribute("aria-current", "page");
  const tree = reader.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("link", { name: "Introduction" })).toBeVisible();
  await expect(tree.getByRole("link", { name: "List posts GET", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(tree.getByRole("link", { name: "Delete a post DELETE", exact: true })).toBeVisible();
  await expect(tree.getByText("Purge everything")).toHaveCount(0);
  await tree.getByRole("link", { name: "Create a post POST", exact: true }).click();

  const page = reader.getByRole("article", { name: "Create a post" });
  await expect(page).toBeVisible();
  await expect(reader).toHaveTitle(/^Create a post · Reference/);
  await expect(page.getByText("POST", { exact: true })).toBeVisible();
  await expect(page.getByText("/posts", { exact: true })).toBeVisible();
  // The description's Markdown, rendered.
  await expect(page.locator("strong", { hasText: "first status" })).toBeVisible();
  await expect(page.getByText("Authorization Bearer token")).toBeVisible();
  // The body's fields: name, type, limits, required, description, default and allowed values.
  const body = page.getByRole("region", { name: "Body" });
  await expect(body.getByText("application/json · object · required")).toBeVisible();
  const title = body.getByRole("listitem").filter({ hasText: "What the post asks." });
  await expect(title).toContainText("title");
  await expect(title).toContainText("string · 3–200 characters");
  await expect(title).toContainText("required");
  await expect(body.getByRole("listitem").filter({ hasText: "Default:" })).toContainText('One of"open""planned"');
  // Each response is a row that opens to its fields; a field with fields of its own opens too.
  const responses = page.getByRole("region", { name: "Responses" });
  await expect(responses.getByText("The body isn't valid")).toBeVisible();
  await expect(responses.getByText("author", { exact: true })).toBeHidden();
  await responses.getByText("The new post").click();
  await expect(responses.getByText("author", { exact: true })).toBeVisible();
  await responses.locator("summary").filter({ hasText: "1 property" }).click();
  await expect(responses.getByText("Their display name.")).toBeVisible();

  // Beside it: the request as cURL, then Python; Copy copies the one shown.
  const request = reader.getByRole("region", { name: "Request example" });
  await expect(request.getByRole("radio", { name: "cURL", exact: true })).toBeChecked();
  await expect(request.getByText("curl 'https://api.acme.example/v1/posts'")).toBeVisible();
  await expect(request.getByText("Authorization: Bearer YOUR_API_KEY")).toBeVisible();
  expect((await request.boundingBox())!.x).toBeGreaterThan((await page.boundingBox())!.x + (await page.boundingBox())!.width);
  await checkpoint(reader, "operation-desktop", { fullPage: false });
  await request.getByText("Python", { exact: true }).click();
  await expect(request.getByRole("radio", { name: "Python", exact: true })).toBeChecked();
  await expect(request.getByText("response = requests.post(")).toBeVisible();
  await expect(request.getByText("curl 'https://api.acme.example/v1/posts'")).toBeHidden();
  await reader.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.getByRole("button", { name: "Copy code" }).click();
  await expect.poll(() => reader.evaluate(() => navigator.clipboard.readText())).toContain("requests.post(");
  // And each response's example, by status.
  const response = reader.getByRole("region", { name: "Response example" });
  await expect(response.getByText('"number": 128')).toBeVisible();
  await response.getByText("400", { exact: true }).click();
  await expect(response.getByText('"error": "Title is required"')).toBeVisible();
  await expect(response.getByText('"number": 128')).toBeHidden();
  await checkpoint(reader, "operation-python-and-400", { fullPage: false });

  // A deprecated operation says so, and its path's parameter is marked.
  await tree.getByRole("link", { name: "Delete a post DELETE", exact: true }).click();
  const deleting = reader.getByRole("article", { name: "Delete a post" });
  await expect(deleting.getByText("Deprecated", { exact: true })).toBeVisible();
  await expect(deleting.getByText("{number}", { exact: true })).toBeVisible();
  await expect(deleting.getByRole("region", { name: "Path parameters" }).getByRole("listitem")).toContainText("integer · at least 1");

  // On a phone the examples come after the page, and the tree is in the menu.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/docs/reference/create-a-post");
  await expect(page).toBeVisible();
  await expect(tree).toBeHidden();
  const [content, example] = [(await page.boundingBox())!, (await request.boundingBox())!];
  expect(example.y).toBeGreaterThanOrEqual(content.y + content.height);
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(reader, "operation-phone");

  // A hidden operation, and one the reference doesn't have, are not found.
  for (const missing of ["purge-everything", "no-such-operation"]) {
    expect((await reader.goto(`/docs/reference/${missing}`))!.status()).toBe(404);
  }
});
