import { Marked, type Tokens } from "marked";

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

/**
 * Each pipe made one a table reads as text, not as the cell's end, in one pass. A table takes a pipe after an odd run of
 * backslashes as escaped (and Markdown reads `\|` as a pipe), so that one stays as written; one after an even run (none,
 * or an escaped backslash `\\`) gets a backslash of its own. Every other backslash stays: a cell keeps its Markdown, and
 * its escapes read as they did outside the table.
 */
function escapePipes(text: string): string {
  let escaped = "";
  let backslashes = 0;
  for (const char of text) {
    if (char === "|" && backslashes % 2 === 0) escaped += "\\";
    escaped += char;
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  return escaped;
}

/** Text in a table's cell: Markdown kept, its lines joined into one, its pipes escaped. */
const cell = (text: string) =>
  escapePipes(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" "),
  );

/** The longest run of backticks in some text. */
const longestTicks = (text: string) => Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));

/** Code in a fence longer than any run of backticks in it. */
function fence(code: string, language: string) {
  const marks = "`".repeat(Math.max(2, longestTicks(code)) + 1);
  return `${marks}${language}\n${code}\n${marks}`;
}

/**
 * A name as code in a table's cell, as written: between more backticks than any run in it (a space inside them when it
 * starts or ends with one), its pipes escaped (escapePipes). A code span takes backslashes as they are, so the one place
 * it reads differently is a backslash right before a pipe: the table takes the two as an escaped pipe.
 */
function codeCell(name: string) {
  const marks = "`".repeat(longestTicks(name) + 1);
  const pad = name.startsWith("`") || name.endsWith("`") ? " " : "";
  return `${marks}${pad}${escapePipes(name)}${pad}${marks}`;
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
    ...rows.map((row) => `| ${codeCell(row.name)} | ${cell(row.type)} | ${row.required ? "Yes" : "No"} | ${row.about} |`),
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

/** HTML's elements (and a few old ones specs still write). Any other tag in a spec's Markdown is a placeholder, `/docs/<slug>`. */
const ELEMENTS = new Set(
  (
    "a abbr address article aside audio b bdi bdo big blockquote body button canvas caption center cite code colgroup data " +
    "datalist dd del details dfn dialog div dl dt em fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hgroup " +
    "html i iframe ins kbd label legend li main map mark menu meter nav noscript object ol optgroup option output p " +
    "picture pre progress q rp rt ruby s samp script search section select slot small span strike strong style sub summary sup svg " +
    "table tbody td template textarea tfoot th thead time title tr tt u ul var video"
  ).split(" "),
);
/** Elements HTML lets go unclosed (and `<br>`'s kind, never closed). Any other element is HTML only when the text after it closes it: `<code>` alone is a placeholder. */
const UNCLOSED = new Set("br hr img wbr p li dt dd tr td th thead tbody tfoot".split(" "));

/** Whether `tag` (`<slug>`, `</b>`, a comment), followed by `rest`, is HTML rather than a placeholder. */
function isHtml(tag: string, rest: string): boolean {
  const name = /^<\/?([a-zA-Z][\w-]*)/.exec(tag)?.[1]?.toLowerCase();
  if (!name || UNCLOSED.has(name) || (tag.startsWith("</") && ELEMENTS.has(name))) return true;
  if (!ELEMENTS.has(name)) return false;
  // Closed later on: by a close no later open of its name takes, outside code (`</code>` in a code span closes nothing).
  let open = 0;
  for (const [, close] of rest.replace(/(`+)[^]*?\1/g, "").matchAll(new RegExp(`<(/?)${name}(?=[\\s/>])`, "gi"))) {
    open += close ? -1 : 1;
    if (open < 0) return true;
  }
  return false;
}

/** A spec's Markdown (a description) as HTML, for the converter to make content of: its placeholders (`<slug>`, `<code>`) kept as text. */
export function specHtml(markdown: string): string {
  return new Marked({
    gfm: true,
    // A placeholder is read as the text it is, not as HTML; HTML's own tags as marked reads them. (marked's types
    // have each tokenizer return its own kind of token, but it takes any.)
    tokenizer: {
      tag(src) {
        const tag = this.rules.inline.tag.exec(src)?.[0];
        return tag !== undefined && !isHtml(tag, src.slice(tag.length)) && ({ type: "text", raw: tag, text: tag } as unknown as Tokens.Tag);
      },
      html(src) {
        const cap = this.rules.block.html.exec(src);
        const tag = cap && /^ *(<[^<>]*>?)/.exec(cap[0])?.[1];
        return !!tag && !isHtml(tag, src.slice(src.indexOf(tag) + tag.length)) && ((this.lexer.state.top ? this.paragraph(src) : this.text(src)) as unknown as Tokens.HTML);
      },
    },
  }).parse(markdown, { async: false });
}
