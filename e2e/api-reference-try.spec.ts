import { randomUUID } from "node:crypto";

import { type ApiFake, startApiFake } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** Two local APIs: one that lets browsers call it (CORS), one that doesn't, which Tuti calls instead. */
let open: ApiFake;
let closed: ApiFake;
test.beforeAll(async () => {
  [open, closed] = await Promise.all([startApiFake({ cors: true }), startApiFake({ cors: false })]);
});
test.afterAll(async () => {
  await Promise.all([open.close(), closed.close()]);
});

const spec = () => `
openapi: 3.1.0
info: { title: Acme API, version: "1" }
servers:
  - { url: "${open.origin}/v1", description: Production }
  - { url: "${closed.origin}/v1", description: Legacy }
components:
  securitySchemes:
    key: { type: http, scheme: bearer }
security: [{ key: [] }]
paths:
  /posts:
    post:
      tags: [Posts]
      summary: Create a post
      parameters:
        - { name: board, in: query, schema: { type: string }, example: ideas }
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, properties: { title: { type: string } } }
            example: { title: Dark mode for the editor }
      responses: { "201": { description: The new post } }
`;

test("a reader tries an operation with their key: from the browser, and through Tuti when the API doesn't allow browsers", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/api-references", { name: "Reference", spec: spec() });

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs/reference/create-a-post");
  await reader.getByRole("button", { name: "Try it" }).click();
  const panel = reader.getByRole("dialog", { name: "Try it" });
  // Prefilled from the examples: the query parameter and the body.
  await expect(panel.getByLabel("board")).toHaveValue("ideas");
  await expect(panel.getByRole("textbox", { name: "Body" })).toHaveValue(/"title": "Dark mode for the editor"/);
  await expect(panel.getByText("Kept in this tab until you close it.")).toBeVisible();
  await panel.getByLabel("Bearer token").fill("sk_test_123");
  await panel.getByRole("button", { name: "Send" }).click();

  const response = panel.getByRole("region", { name: "Response" });
  await expect(response.getByText("201 Created")).toBeVisible();
  await expect(response.getByText('"path": "/v1/posts"')).toBeVisible();
  await expect(response.getByText(/Sent through Tuti/)).toHaveCount(0);
  // Straight from the browser, with the key.
  expect(open.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/posts", query: "?board=ideas", headers: { authorization: "Bearer sk_test_123" } });
  await checkpoint(reader, "console-desktop", { fullPage: false });

  // An API that doesn't let browsers call it: through Tuti, which says so.
  await panel.getByRole("combobox", { name: "Server" }).selectOption({ label: `Legacy (${closed.origin}/v1)` });
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(response.getByText("Sent through Tuti, since the API doesn't allow browser requests.")).toBeVisible();
  await expect(response.getByText("201 Created")).toBeVisible();
  expect(closed.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/posts", headers: { authorization: "Bearer sk_test_123", "user-agent": "Tuti-Try-It/1" } });
  // None of the reader's own cookies went on.
  expect(closed.requests.at(-1)!.headers.cookie).toBeUndefined();
  await checkpoint(reader, "console-through-tuti", { fullPage: false });

  // The key stays for this tab: closed and opened again, it's still there.
  await reader.keyboard.press("Escape");
  await reader.getByRole("button", { name: "Try it" }).click();
  await expect(reader.getByRole("dialog", { name: "Try it" }).getByLabel("Bearer token")).toHaveValue("sk_test_123");

  // On a phone, a sheet from the bottom that fits the width.
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(reader.getByRole("dialog", { name: "Try it" })).toBeVisible();
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(reader, "console-phone", { fullPage: false });
});

test("no Try it where there's nowhere to send a request", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Servers without a host, and no base address set.
  await api("/api-references", { name: "Reference", spec: spec().replace(/url: "[^"]+"/g, 'url: "/v1"') });
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/docs/reference/create-a-post");
  await expect(reader.getByRole("heading", { name: "Create a post", level: 1 })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Try it" })).toHaveCount(0);
});
