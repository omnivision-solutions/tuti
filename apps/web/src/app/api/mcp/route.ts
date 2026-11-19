import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { log } from "@tuti/shared";

import { type ApiKey, authenticate, refusal } from "@/server/api-auth";
import { OperationError, operations, toolName } from "@/server/operations";
import { errorsLine, inputSchema, outputSchema } from "@/server/operations/openapi";

/**
 * The MCP server (Streamable HTTP, stateless): every operation is a tool, so AI
 * assistants can search, triage and answer feedback. Authenticated like the REST
 * API, with a project API key as the bearer token; a key only sees the tools it may run (read-only keys, read tools).
 */
async function handle(request: Request) {
  const actor = await authenticate(request);
  if (actor instanceof Response) {
    return actor;
  }
  const server = mcpServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function mcpServer(actor: ApiKey) {
  const tools = operations.filter((operation) => !refusal(actor, operation));
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
      const output = outputSchema(operation);
      return {
        name: toolName(operation),
        title: operation.title,
        description: [operation.summary, errorsLine(operation)].filter(Boolean).join("\n\n"),
        inputSchema: { type: "object" as const, ...inputSchema(operation) },
        ...(output && { outputSchema: { type: "object" as const, ...output } }),
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
    const input = operation.input.safeParse(request.params.arguments ?? {});
    if (!input.success) {
      const issue = input.error.issues[0];
      return failure(issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input");
    }
    try {
      const text = JSON.stringify(await operation.run({ actor, projectId: actor.projectId }, input.data), null, 2);
      // As JSON, like the text: what `outputSchema` describes (a date is its ISO string).
      return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
    } catch (error) {
      if (error instanceof OperationError) {
        return failure(error.message);
      }
      log.error("MCP tool failed", { tool: operation.name, error });
      return failure("Something went wrong");
    }
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
