import { graphqlResponse, graphqlSignature, requestExamples } from "./examples";
import type { ApiDoc, ApiOperation, ApiParam, ApiSchema } from "./types";

/**
 * An operation's page as Markdown (its `.md`, Copy page, llms-full.txt): its title, method and path, description,
 * parameters as a table, its body's and responses' fields, and the request as cURL with a response's example.
 * GraphQL's: its signature, arguments, the type it returns with its fields, the query and its variables, and an answer.
 * A spec's descriptions are Markdown already, so they go in as written (a table's cells on one line).
 */
export function operationMarkdown(doc: ApiDoc, operation: ApiOperation, options: { base?: string } = {}): string {
  const graphql = doc.format === "graphql";
  const parts = [`# ${inline(operation.title)}`];
  parts.push(graphql ? `\`${operation.kind} ${graphqlSignature(operation)}\`` : `\`${operation.kind} ${operation.path}\``);
  if (operation.deprecated) parts.push("**Deprecated**");
  if (operation.description.trim()) parts.push(operation.description.trim());
  for (const [place, title] of PLACES) {
    const params = operation.params.filter((param) => param.in === place);
    if (params.length > 0) parts.push(`## ${title}`, table("Name", params.map(paramRow)));
  }
  if (operation.body) {
    const { contentType, schema, required } = operation.body;
    parts.push("## Body", [contentType, ...typeLine(schema), required && "required"].filter(Boolean).join(" · "), ...schemaParts(schema));
  }
  const returned = operation.responses[0]?.schema;
  if (graphql && returned) {
    parts.push("## Returns", `\`${returned.type}\``, ...schemaParts(returned));
  } else if (!graphql && operation.responses.length > 0) {
    parts.push("## Responses");
    for (const response of operation.responses) {
      parts.push(`### ${response.status}`);
      if (response.description.trim()) parts.push(response.description.trim());
      if (response.schema) parts.push([response.contentType, ...typeLine(response.schema)].filter(Boolean).join(" · "), ...schemaParts(response.schema));
    }
  }
  if (operation.query) {
    parts.push("## Query", fence(operation.query.text, "graphql"));
    if (Object.keys(operation.query.variables).length > 0) parts.push("Variables:", fence(JSON.stringify(operation.query.variables, null, 2), "json"));
  }
  parts.push("## Request example", fence(requestExamples(doc, operation, options).curl, "bash"));
  const response = graphql ? { status: "", example: graphqlResponse(operation), contentType: "application/json" } : operation.responses.find((r) => r.example !== undefined);
  if (response) {
    const json = typeof response.example !== "string" || /json/i.test(response.contentType ?? "");
    parts.push(
      response.status ? `## Response example (${response.status})` : "## Response example",
      fence(json ? JSON.stringify(response.example, null, 2) : String(response.example), json ? "json" : ""),
    );
  }
  return `${parts.join("\n\n")}\n`;
}

/** Where parameters go, in the order the page lists them. */
const PLACES: [ApiParam["in"], string][] = [
  ["path", "Path parameters"],
  ["query", "Query parameters"],
  ["header", "Headers"],
  ["cookie", "Cookies"],
  ["argument", "Arguments"],
];

const typeLine = (schema: ApiSchema) => [schema.type, schema.format, schema.nullable && "nullable", schema.constraints];

/** Text in a line of Markdown: its marks escaped. */
const inline = (text: string) => text.replace(/[\\`*_[\]<>#|~]/g, "\\$&").replace(/\s+/g, " ");

/** Text in a table's cell: Markdown kept, on one line, its pipes escaped. */
const cell = (text: string) => text.trim().replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");

/** Code in a fence longer than any run of backticks in it. */
function fence(code: string, language: string) {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${language}\n${code}\n${marks}`;
}

/** A schema's own words (description, default, allowed values), in a cell. */
function about(schema: ApiSchema, description?: string) {
  return cell(
    [
      description || schema.description || "",
      schema.default !== undefined && `Default: \`${JSON.stringify(schema.default)}\``,
      schema.enum?.length && `One of: ${schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(", ")}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

type Row = { name: string; type: string; required: boolean; about: string };

const table = (first: string, rows: Row[]) =>
  [
    `| ${first} | Type | Required | Description |`,
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| \`${row.name.replace(/[`|]/g, "\\$&")}\` | ${cell(row.type)} | ${row.required ? "Yes" : "No"} | ${row.about} |`),
  ].join("\n");

const paramRow = (param: ApiParam): Row => ({
  name: param.name,
  type: typeLine(param.schema).filter(Boolean).join(" · "),
  required: param.required,
  about: about(param.schema, param.description),
});

/** A body's, response's or returned type's own description and its fields as a table (`author.name`, `tags[].id`). */
function schemaParts(schema: ApiSchema): string[] {
  const rows = fieldRows(schema, "");
  return [...(schema.description?.trim() ? [schema.description.trim()] : []), ...(rows.length > 0 ? [table("Field", rows)] : [])];
}

/** Its fields, each followed by the fields in it, as deep as the reader spelled them out (two levels). */
function fieldRows(schema: ApiSchema, prefix: string): Row[] {
  let at = schema;
  let path = prefix;
  while (at.items) {
    at = at.items;
    path = path && `${path}[]`;
  }
  if (at.oneOf?.length) {
    return at.oneOf.flatMap((option, i) => [
      { name: `${path ? `${path}.` : ""}Option ${i + 1}`, type: typeLine(option).filter(Boolean).join(" · "), required: false, about: about(option) },
      ...fieldRows(option, path),
    ]);
  }
  return (at.properties ?? []).flatMap((property) => {
    const name = path ? `${path}.${property.name}` : property.name;
    return [{ name, type: typeLine(property).filter(Boolean).join(" · "), required: property.required, about: about(property) }, ...fieldRows(property, name)];
  });
}
