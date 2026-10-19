import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { log } from "@tuti/shared";

import { authenticate } from "@/server/api-auth";
import { type ApiKeyActor, OperationError, operations, toolName } from "@/server/operations";
import { inputSchema } from "@/server/operations/openapi";

/**
 * The MCP server (Streamable HTTP, stateless): every operation is a tool, so AI
 * assistants can search, triage and answer feedback. Authenticated like the REST
 * API, with a project API key as the bearer token; read-only keys only see read tools.
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

function mcpServer(actor: ApiKeyActor) {
  const tools = operations.filter((operation) => operation.scope === "read" || actor.scope === "write");
  const server = new Server(
    { name: "tuti", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Tuti holds one project's product feedback: boards of posts that users vote and comment on, each with a status. Posts are identified by their number.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((operation) => ({
      name: toolName(operation),
      description: operation.summary,
      inputSchema: { type: "object" as const, ...inputSchema(operation) },
      annotations: { readOnlyHint: operation.scope === "read" },
    })),
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
      const result = (await operation.run({ actor, projectId: actor.projectId }, input.data)) as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
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

export { handle as DELETE, handle as GET, handle as POST };
