import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ApiKey, authenticate } from "@/server/api-auth";
import { operations, toolName } from "@/server/operations";
import { authorize } from "@/server/operations/define";
import { keyContext } from "@/server/trpc/context";
import { callOperation } from "@/server/trpc/server";
import { agentOutputSchema, errorsLine, inputSchema } from "@/server/operations/openapi";

/**
 * The MCP server (Streamable HTTP, stateless): every operation of the public API is a tool, so AI assistants can
 * search, triage and answer feedback. Authenticated like the REST API, with a project API key as the bearer token, and
 * called through the router (server/trpc) as the key; a key only sees the tools the router would let it run (the same
 * check: read-only keys, read tools).
 */
async function handle(request: Request) {
  const key = await authenticate(request);
  if (key instanceof Response) {
    return key;
  }
  const server = mcpServer(key, await allowedTools(key));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/** The operations the key may run, by the check the router applies (authorize, with the key's creator's role). */
async function allowedTools({ role, ...actor }: ApiKey) {
  const allowed = await Promise.all(operations.map((operation) => authorize(operation, { actor, projectId: actor.projectId }, role).then(() => true, () => false)));
  return operations.filter((_, i) => allowed[i]);
}

function mcpServer(key: ApiKey, tools: typeof operations) {
  const server = new Server(
    { name: "tuti", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Tuti runs one project's customer-facing side: feedback (boards of posts people vote and comment on, each with a status, and the roadmap), the changelog, docs (articles in collections and tabs, with AI answers) and API references, an inbox of conversations with users, Autopilot (updates it proposes to posts and articles from merged pull requests), users with their reader groups, and the portal's settings (who may read it, its address, branding, the widget). Posts, changelog entries and conversations are identified by their number; articles, collections, tabs and API references by their slug; reader groups by their key; users by their id in your app, portal readers by email; comments, code changes, their actions and redirects by id.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((operation) => {
      return {
        name: toolName(operation),
        title: operation.title,
        description: [operation.summary, errorsLine(operation)].filter(Boolean).join("\n\n"),
        inputSchema: { type: "object" as const, ...inputSchema(operation) },
        outputSchema: { type: "object" as const, ...agentOutputSchema(operation) },
        annotations: { readOnlyHint: operation.scope === "read" },
      };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
    const operation = tools.find((t) => toolName(t) === request.params.name);
    if (!operation) {
      return failure(`Unknown tool ${request.params.name}`);
    }
    const called = await callOperation(keyContext(key), operation, { ...request.params.arguments, project: undefined });
    if (!called.ok) {
      return failure(called.message);
    }
    const text = JSON.stringify(called.result, null, 2);
    // As JSON, like the text: what `outputSchema` describes (a date is its ISO string).
    return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
  });
  return server;
}

/** Stateless: nothing to stream to clients, so no GET event stream (the SDK would hold one open). */
function methodNotAllowed() {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
    { status: 405, headers: { Allow: "POST, DELETE" } },
  );
}

export { handle as DELETE, methodNotAllowed as GET, handle as POST };
