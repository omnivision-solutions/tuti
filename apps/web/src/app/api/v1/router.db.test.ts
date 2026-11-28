import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prisma } from "@tuti/db";
import { beforeEach, expect, test, vi } from "vitest";

import { createApiKey } from "@/server/api-keys";
import { actAs, callerAs, createProject, signUp } from "@/test/helpers";

import { DELETE, GET as mcpGet, POST } from "../mcp/route";
import { GET, POST as rest } from "./[...path]/route";

// `project.get` as an internal operation (the app needs it, the public API doesn't), with its path left on: what keeps
// it out of REST and MCP is the flag alone.
vi.mock("@/server/operations/more", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/operations/more")>();
  const { defineOperation } = await import("@/server/operations/define");
  const { name, title, summary, method, path, scope, access, input, output } = actual.getProject;
  const getProject = defineOperation({
    name,
    title,
    summary,
    method,
    path,
    scope,
    access,
    input,
    output,
    internal: true,
    run: async () => ({ slug: "internal", name: "Internal", uses: [], portalUrl: "http://internal.localhost:3100" }),
  });
  return { ...actual, getProject };
});

/** REST and MCP call the router (docs/plan.md, "One way in", T2). */

let key: string;
let keyId: string;
let readKey: string;

beforeEach(async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  key = (await createApiKey(project.slug, "Tests", "WRITE")).key!;
  keyId = (await prisma.apiKey.findFirstOrThrow({ where: { projectId: project.id } })).id;
  readKey = (await createApiKey(project.slug, "Read", "READ")).key!;
});

test("an internal operation is in the router, but neither REST nor MCP serves it", async () => {
  // The router has it.
  expect(await (await callerAs({ apiKeyId: keyId })).project.get({})).toMatchObject({ slug: "internal" });

  const url = "http://tuti.localhost:3100/api/v1/project";
  const response = await GET(new Request(url, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ path: ["project"] }) });
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: { code: "not_found", message: "No such endpoint" } } });

  const transport = new StreamableHTTPClientTransport(new URL("http://tuti.localhost:3100/api/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
    fetch: (input, init) => {
      const request = new Request(input, init);
      const handlers: Record<string, (request: Request) => Response | Promise<Response>> = { GET: mcpGet, POST, DELETE };
      return Promise.resolve(handlers[request.method]!(request));
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).not.toContain("project_get");
  expect(tools.map((tool) => tool.name)).toContain("team_list");
  expect(await client.callTool({ name: "project_get", arguments: {} })).toMatchObject({ isError: true, content: [{ text: "Unknown tool project_get" }] });
});

test("who may comes before what they sent: a read-only key writing a bad post is refused, not told how to fix it", async () => {
  const response = await rest(
    new Request("http://tuti.localhost:3100/api/v1/posts", {
      method: "POST",
      headers: { authorization: `Bearer ${readKey}`, "content-type": "application/json" },
      body: JSON.stringify({ board: "feature-requests", title: "x" }),
    }),
    { params: Promise.resolve({ path: ["posts"] }) },
  );
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 403,
    body: { error: { code: "forbidden", message: "This key can only read. Create a read + write key to change things." } },
  });
});
