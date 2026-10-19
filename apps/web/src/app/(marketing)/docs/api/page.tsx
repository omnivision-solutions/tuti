import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { appUrl } from "@/lib/hosts";
import { operations } from "@/server/operations";
import { inputSchema, pathParams } from "@/server/operations/openapi";

export const metadata: Metadata = {
  title: "API · Tuti",
  description: "Read and change your project's feedback from code with Tuti's REST API.",
};

type Schema = { type?: string; enum?: unknown[]; default?: unknown; minimum?: number; maximum?: number };

/** A short, readable type for a parameter. */
function typeOf(schema: Schema | undefined): string {
  if (!schema) {
    return "";
  }
  if (schema.enum) {
    return schema.enum.map(String).join(" | ");
  }
  const range =
    schema.minimum !== undefined && schema.maximum !== undefined && schema.maximum < 1e6
      ? ` (${schema.minimum}–${schema.maximum})`
      : "";
  return `${schema.type ?? "document"}${range}`;
}

function curl(operation: (typeof operations)[number], base: string): string {
  let path = operation.path.replace("{number}", "1");
  const auth = `-H "Authorization: Bearer $TUTI_API_KEY"`;
  if (operation.method === "GET") {
    if (operation.example) {
      path += `?${new URLSearchParams(Object.entries(operation.example).map(([k, v]) => [k, String(v)]))}`;
    }
    return `curl ${auth} "${base}${path}"`;
  }
  const body = operation.example ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(operation.example)}'` : "";
  return `curl -X ${operation.method} ${auth} "${base}${path}"${body}`;
}

/** Generated from the same operations the API serves, like /api/v1/openapi.json. */
export default function ApiDocsPage() {
  const base = `${appUrl().origin}/api/v1`;

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">API</h1>
        <p className="text-muted-foreground">
          Read and change your project&apos;s feedback from your own code. Base URL{" "}
          <code className="rounded bg-muted px-1 font-mono text-sm">{base}</code>. The full description is at{" "}
          <a href={`${base}/openapi.json`} className="text-primary underline underline-offset-4">
            openapi.json
          </a>{" "}
          (OpenAPI 3.1).
        </p>
      </header>

      <section className="flex flex-col gap-2" aria-labelledby="auth">
        <h2 id="auth" className="text-xl font-bold tracking-tight">
          Keys, limits and errors
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>
            Create a key in your project&apos;s <strong>Settings → API keys</strong> and send it as{" "}
            <code className="font-mono">Authorization: Bearer tuti_…</code>. Keep it on your server. A key works
            for one project.
          </li>
          <li>
            <strong>Read only</strong> keys can use the GET endpoints; changing anything needs a{" "}
            <strong>Read and write</strong> key.
          </li>
          <li>Up to 600 requests a minute per key; over that you get 429 with a Retry-After header.</li>
          <li>
            Errors are <code className="font-mono">{`{ "error": { "code", "message" } }`}</code> with status 400,
            401, 403, 404, 409 or 429.
          </li>
          <li>
            Posts and comments are written by the key&apos;s creator, or on behalf of someone from your app with{" "}
            <code className="font-mono">{`"author": { "id", "name", "email" }`}</code>: their id in your app,
            the same person as with single sign-on.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="mcp">
        <h2 id="mcp" className="text-xl font-bold tracking-tight">
          MCP (for AI assistants)
        </h2>
        <p className="text-sm">
          Every endpoint below is also a tool on Tuti&apos;s MCP server, so assistants like Claude can search, triage
          and answer your feedback. Add it as a remote MCP server (Streamable HTTP) at{" "}
          <code className="rounded bg-muted px-1 font-mono">{appUrl().origin}/mcp</code> with the header{" "}
          <code className="font-mono">Authorization: Bearer tuti_…</code>. Read only keys get only the reading
          tools.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
          <code>{`claude mcp add --transport http tuti ${appUrl().origin}/mcp \\\n  --header "Authorization: Bearer $TUTI_API_KEY"`}</code>
        </pre>
      </section>

      {operations.map((operation) => {
        const schema = inputSchema(operation);
        const properties = (schema.properties ?? {}) as Record<string, Schema>;
        const required = new Set(schema.required ?? []);
        const inPath = pathParams(operation.path);
        return (
          <section key={operation.name} id={operation.name} className="flex flex-col gap-3 border-t pt-6">
            <h2 className="flex flex-wrap items-center gap-2 font-mono text-base font-semibold">
              <Badge variant={operation.method === "GET" ? "secondary" : "soft"}>{operation.method}</Badge>
              <span className="break-all">/api/v1{operation.path}</span>
            </h2>
            <p className="text-sm">
              {operation.summary}.{" "}
              {operation.scope === "write" && <span className="text-muted-foreground">Needs a read and write key.</span>}
            </p>
            {Object.keys(properties).length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="w-32 py-1 pr-4 font-medium">Name</th>
                      <th className="w-16 py-1 pr-4 font-medium">In</th>
                      <th className="py-1 font-medium">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(properties).map(([name, property]) => (
                      <tr key={name} className="border-t">
                        <td className="py-1 pr-4 font-mono">
                          {name}
                          {required.has(name) && !inPath.includes(name) ? " *" : ""}
                        </td>
                        <td className="py-1 pr-4 text-muted-foreground">
                          {inPath.includes(name) ? "path" : operation.method === "GET" ? "query" : "body"}
                        </td>
                        <td className="py-1 font-mono text-xs break-words">{typeOf(property)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
              <code>{curl(operation, base)}</code>
            </pre>
          </section>
        );
      })}
    </article>
  );
}
