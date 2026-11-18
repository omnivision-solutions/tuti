import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";

const SCHEMA = `
"""Read and write posts."""
type Query {
  "A post by its number."
  post(number: Int!, board: BoardInput): Post
}
input BoardInput {
  "The board's slug."
  slug: String!
  archived: Boolean = false
}
type Mutation {
  "Adds a post."
  createPost(input: CreatePostInput!): Post!
}
input CreatePostInput { board: String!, title: String! }
type Subscription { posted: Post }
type Post { number: Int!, title: String!, status: Status!, author: User }
type User { name: String! }
enum Status { OPEN CLOSED }
`;

/**
 * A local GraphQL endpoint that lets browsers call it: it answers any query with a post, and one asking for the field
 * `nope` with an error, as a server does (status 200, `errors`).
 */
let server: Server;
let endpoint: string;
const received: { query: string; variables: unknown; authorization?: string }[] = [];
test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "POST" };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    const { query, variables } = JSON.parse(body) as { query: string; variables: { number?: number } };
    received.push({ query, variables, authorization: request.headers.authorization });
    const answer = query.includes("nope")
      ? { errors: [{ message: 'Cannot query field "nope" on type "Post".', locations: [{ line: 3, column: 5 }] }] }
      : { data: { post: { number: variables.number ?? 1, title: "Dark mode", status: "OPEN" } } };
    response.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
});
test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("a reader reads a GraphQL operation and tries it: the answer's data, then its errors", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/api-references", { name: "Reference", spec: SCHEMA });
  // A schema file names no endpoint: the team's base address is it.
  await api("/api-references/reference", { baseUrl: endpoint }, "PATCH");

  const reader = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs/reference/post");
  await expect(reader.getByRole("heading", { name: "post", level: 1 })).toBeVisible();
  // The tree labels each operation by its kind.
  const tree = reader.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("link", { name: "post query", exact: true })).toBeVisible();
  await tree.getByText("Mutations", { exact: true }).click();
  await expect(tree.getByRole("link", { name: "createPost mutation", exact: true })).toBeVisible();
  // The field, its arguments and what it returns, in GraphQL's notation.
  await expect(reader.getByText("post(number, board): Post", { exact: true })).toBeVisible();
  const args = reader.getByRole("region", { name: "Arguments" });
  await expect(args.getByText("Int!", { exact: true })).toBeVisible();
  // An input type opens to its fields.
  await args.locator("summary", { hasText: "2 fields" }).click();
  await expect(args.getByText("The board's slug.")).toBeVisible();
  await expect(args.getByText("Default:")).toBeVisible();
  const returns = reader.getByRole("region", { name: "Returns" });
  await expect(returns.getByText("Post", { exact: true })).toBeVisible();
  await expect(returns.getByText("Status!", { exact: true })).toBeVisible();
  await returns.locator("summary", { hasText: "1 field" }).click();
  await expect(returns.getByText("String!", { exact: true })).toHaveCount(2);
  // Beside it: the query, its variables and an answer.
  await expect(reader.getByRole("region", { name: "Request example" }).getByText(/^query Post\(\$number: Int!, \$board: BoardInput\)/)).toBeVisible();
  await expect(reader.getByRole("region", { name: "Variables" }).getByText(/"number": 1/)).toBeVisible();
  await expect(reader.getByRole("region", { name: "Response example" }).getByText(/"data": \{/)).toBeVisible();
  await checkpoint(reader, "query-desktop", { fullPage: false });

  await reader.getByRole("button", { name: "Try it" }).click();
  const panel = reader.getByRole("dialog", { name: "Try it" });
  await expect(panel.getByRole("textbox", { name: "Query" })).toHaveValue(/post\(number: \$number, board: \$board\)/);
  await expect(panel.getByRole("textbox", { name: "Variables" })).toHaveValue(/"number": 1/);
  await panel.getByLabel("Bearer token").fill("sk_graph_1");
  await panel.getByRole("textbox", { name: "Variables" }).fill('{ "number": 42 }');
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  const response = panel.getByRole("region", { name: "Response" });
  await expect(response.getByText("200 OK")).toBeVisible();
  await expect(response.getByLabel("Response body")).toContainText('"number": 42');
  await expect(response.getByRole("group", { name: "Errors" })).toHaveCount(0);
  // Straight from the browser, as JSON of the query and variables, with the key.
  expect(received.at(-1)).toMatchObject({ variables: { number: 42 }, authorization: "Bearer sk_graph_1" });
  await checkpoint(reader, "console-data", { fullPage: false });

  // A query with a mistake: its errors are set apart over the body.
  const query = panel.getByRole("textbox", { name: "Query" });
  await query.fill((await query.inputValue()).replace("title", "nope"));
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  const errors = response.getByRole("group", { name: "Errors" });
  await expect(errors.getByText("1 error")).toBeVisible();
  await expect(errors.getByText('Cannot query field "nope" on type "Post".')).toBeVisible();
  await checkpoint(reader, "console-errors", { fullPage: false });

  // Variables that aren't JSON aren't sent.
  const sent = received.length;
  await panel.getByRole("textbox", { name: "Variables" }).fill("{ number: 42 }");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(response.getByText("Variables must be a JSON object")).toBeVisible();
  expect(received).toHaveLength(sent);

  // A subscription has its page, and no Try it.
  await reader.keyboard.press("Escape");
  await reader.goto("/docs/reference/posted");
  await expect(reader.getByRole("heading", { name: "posted", level: 1 })).toBeVisible();
  await expect(reader.getByText("A subscription stays open over a websocket, so it can't be tried here.")).toBeVisible();
  await expect(reader.getByRole("button", { name: "Try it" })).toHaveCount(0);

  // On a phone: the page and the console fit the width.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/docs/reference/create-post");
  await expect(reader.getByRole("heading", { name: "createPost", level: 1 })).toBeVisible();
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(reader, "mutation-phone");
  await reader.getByRole("button", { name: "Try it" }).click();
  await expect(panel.getByRole("textbox", { name: "Query" })).toHaveValue(/mutation CreatePost/);
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(reader, "console-phone", { fullPage: false });
});
