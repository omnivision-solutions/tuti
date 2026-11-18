import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

const SPEC = `
openapi: 3.1.0
info: { title: Acme API, version: "1" }
servers: [{ url: https://api.acme.example/v1 }]
paths:
  /posts:
    post:
      tags: [Posts]
      summary: Create a post
      description: Adds a post to a board.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties:
                title: { type: string, description: What the post asks. }
            example: { title: Dark mode for the editor }
      responses:
        "201":
          description: The new post
          content: { application/json: { schema: { type: object, properties: { number: { type: integer } } }, example: { number: 128 } } }
`;

test("a reader copies an API operation's page as Markdown, and opens its .md", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const { slug: tab } = await api("/tabs", { name: "API" });
  await api("/api-references", { name: "Reference", spec: SPEC, tab });

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs/reference/create-a-post");
  await expect(reader.getByRole("heading", { name: "Create a post", level: 1 })).toBeVisible();

  // Its Markdown, at the page's address with .md: what it is, takes and answers, and the request as cURL.
  const markdownUrl = `${portalUrl(slug)}/docs/reference/create-a-post.md`;
  const markdown = await reader.request.get(markdownUrl);
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  const text = await markdown.text();
  expect(text).toContain("# Create a post\n\n`POST /posts`\n\nAdds a post to a board.\n\n## Body");
  expect(text).toContain("| `title` | string | Yes | What the post asks. |");
  expect(text).toContain("curl 'https://api.acme.example/v1/posts'");

  // Copy page and its menu, as on an article.
  await reader.getByRole("button", { name: "More page actions" }).click();
  await expect(reader.getByRole("menuitem", { name: "View as Markdown", exact: true })).toHaveAttribute("href", markdownUrl);
  await expect(reader.getByRole("menuitem", { name: "Open in Claude", exact: true })).toBeVisible();
  await checkpoint(reader, "api-operation-copy-menu", { fullPage: false });
  await reader.keyboard.press("Escape");
  await reader.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await reader.getByRole("button", { name: "Copy page" }).click();
  await expect(reader.getByText("Copied as Markdown")).toBeVisible();
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(text);

  // Opened in the browser: the Markdown, as text.
  await reader.goto(markdownUrl);
  await expect(reader.locator("body")).toContainText("# Create a post");
});
