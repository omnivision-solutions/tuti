import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { createApiKey } from "@/server/api-keys";
import { operations, toolName } from "@/server/operations";
import { actAs, createProject, signUp } from "@/test/helpers";

import { DELETE, GET, POST } from "./route";

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  const owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

/** The SDK's own MCP client, talking to the route handlers. */
async function connect(scope: "READ" | "WRITE" | null) {
  const key = scope && (await createApiKey(project.slug, `MCP ${scope}`, scope)).key!;
  const handlers: Record<string, (request: Request) => Response | Promise<Response>> = { GET, POST, DELETE };
  const transport = new StreamableHTTPClientTransport(new URL("http://tuti.localhost:3100/mcp"), {
    requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : {},
    fetch: (url, init) => {
      const request = new Request(url, init);
      return Promise.resolve(handlers[request.method]!(request));
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("read-only keys get the read tools; tools return the same data as the API", async () => {
  const client = await connect("READ");
  const { tools } = await client.listTools();
  const readTools = operations.filter((o) => o.scope === "read").map(toolName);
  expect(tools.map((t) => t.name).sort()).toEqual(readTools.sort());
  // Named too, so a scope change can't drop one from both sides of the check above.
  expect(readTools).toEqual(
    expect.arrayContaining(["project_get", "team_list", "boards_list", "posts_list", "posts_get", "comments_list", "duplicates_list", "articles_search"]),
  );
  expect(tools.find((t) => t.name === "posts_list")).toMatchObject({
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { status: { enum: expect.arrayContaining(["planned"]) } } },
  });

  const result = await client.callTool({ name: "boards_list", arguments: {} });
  expect(result.structuredContent).toEqual({ boards: [{ slug: "feature-requests", name: "Feature requests", posts: 0 }] });
  // Write tools aren't there for this key at all.
  expect(await client.callTool({ name: "posts_create", arguments: { board: "feature-requests", title: "Hi there" } })).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "Unknown tool posts_create" }],
  });
});

test("with a read and write key, an assistant can post, triage and answer", async () => {
  const client = await connect("WRITE");
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
    expect.arrayContaining(["posts_create", "comments_create", "posts_update", "posts_merge"]),
  );

  await client.callTool({ name: "posts_create", arguments: { board: "feature-requests", title: "Dark mode", body: "Please" } });
  expect(await client.callTool({ name: "posts_update", arguments: { number: 1, status: "planned" } })).toMatchObject({
    structuredContent: { number: 1, status: "planned" },
  });
  await client.callTool({ name: "comments_create", arguments: { number: 1, body: "Planned for June." } });

  const post = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, include: { comments: true } });
  expect(post).toMatchObject({ title: "Dark mode", status: "PLANNED", commentCount: 1 });
});

test("bad arguments and missing posts come back as tool errors, not crashes", async () => {
  const client = await connect("WRITE");
  expect(await client.callTool({ name: "posts_get", arguments: { number: 99 } })).toMatchObject({
    isError: true,
    content: [{ text: "There's no post #99" }],
  });
  expect(await client.callTool({ name: "posts_create", arguments: { board: "feature-requests", title: "x" } })).toMatchObject({
    isError: true,
    content: [{ text: "title: Title is too short" }],
  });
});

test("without a valid key there's no MCP at all", async () => {
  await expect(connect(null)).rejects.toThrow();
  const response = await POST(
    new Request("http://tuti.localhost:3100/mcp", {
      method: "POST",
      headers: { authorization: `Bearer tuti_${"x".repeat(43)}`, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(401);
});

test("there's no event stream to hold open: GET is 405", async () => {
  const response = await GET();
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST, DELETE");
});
