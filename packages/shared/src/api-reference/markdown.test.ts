import { describe, expect, it } from "vitest";

import { readGraphql } from "./graphql";
import { operationMarkdown, specHtml } from "./markdown";
import { readOpenApi } from "./openapi";
import type { ApiDoc } from "./types";

const read = (result: ReturnType<typeof readOpenApi>): ApiDoc => {
  if ("error" in result) throw new Error(result.error);
  return result.doc;
};

const SPEC = `
openapi: 3.1.0
info: { title: Acme, version: "1" }
servers: [{ url: "https://api.acme.test" }]
paths:
  /posts/{number}:
    patch:
      summary: Update a *post*
      description: "Changes a post.\\n\\nSee [limits](https://acme.test/limits)."
      parameters:
        - { name: number, in: path, required: true, description: "The post's | number", schema: { type: integer, minimum: 1 } }
        - { name: expand, in: query, schema: { type: string, enum: [author], default: author } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties:
                title: { type: string, description: "Its title\\non two lines" }
                tags: { type: array, items: { type: object, properties: { id: { type: integer } } } }
      responses:
        "200":
          description: The post
          content:
            application/json:
              schema: { type: object, properties: { code: { type: string, example: "\`\`\`" } } }
        "404": { description: No such post }
`;

describe("operationMarkdown", () => {
  it("writes an OpenAPI operation: title, method and path, description, parameters, body and responses with their fields, and the examples", () => {
    const doc = read(readOpenApi(SPEC));
    const text = operationMarkdown(doc, doc.operations[0]!);
    expect(text.startsWith("# Update a \\*post\\*\n\n`PATCH /posts/{number}`\n\nChanges a post.\n\nSee [limits](https://acme.test/limits).\n\n## Path parameters\n")).toBe(true);
    expect(text).toContain("| `number` | integer · at least 1 | Yes | The post's \\| number |");
    expect(text).toContain('| `expand` | string | No | Default: `"author"` One of: `"author"` |');
    expect(text).toContain("## Body\n\napplication/json · object · required\n\n| Field |");
    expect(text).toContain("| `title` | string | Yes | Its title on two lines |");
    expect(text).toContain("| `tags[].id` | integer | No |  |");
    expect(text).toContain("## Responses\n\n### 200\n\nThe post");
    expect(text).toContain("### 404\n\nNo such post");
    expect(text).toContain("## Request example\n\n```bash\ncurl 'https://api.acme.test/posts/1' \\\n  --request PATCH");
    // A fence longer than the backticks inside it.
    expect(text).toContain('## Response example (200)\n\n````json\n{\n  "code": "```"\n}\n````');
  });

  it("keeps every row one row: lines joined in linear time, a pipe always the cell's text, a name as written", () => {
    const doc = read(readOpenApi(SPEC));
    const operation = doc.operations[0]!;
    const row = (name: string, description: string) =>
      operationMarkdown(doc, { ...operation, params: [{ ...operation.params[0]!, name, description }] })
        .split("\n")
        .find((line) => line.startsWith("| `") || line.startsWith("| ``"))!;
    // Long runs of spaces and line breaks, where a backtracking pattern takes polynomial time (the code has none, which
    // CodeQL checks): each line trimmed, blank ones dropped, the rest joined with a space; spaces inside a line kept.
    expect(row("number", `a${" \n ".repeat(100_000)}  b \r\n c`)).toBe("| `number` | integer · at least 1 | Yes | a b c |");
    expect(row("number", `a${" ".repeat(100_000)}b${"\n".repeat(100_000)}`)).toBe(`| \`number\` | integer · at least 1 | Yes | a${" ".repeat(100_000)}b |`);
    // An escaped pipe stays escaped (it reads as a pipe, as it did outside the table); an escaped backslash before one
    // stays a backslash, and the pipe gets its own escape, so neither ends the cell.
    expect(row("number", "a \\| b")).toContain("| a \\| b |");
    expect(row("number", "C:\\\\| b")).toContain("| C:\\\\\\| b |");
    expect(row("number", "a | b")).toContain("| a \\| b |");
    // Other backslashes are the description's Markdown: kept.
    expect(row("number", "\\*not emphasis\\*")).toContain("| \\*not emphasis\\* |");
    // A name is code as written: its backslashes kept, a pipe escaped, backticks inside more of them.
    expect(row("a\\b", "")).toMatch(/^\| `a\\b` \|/);
    expect(row("a|b", "")).toMatch(/^\| `a\\\|b` \|/);
    expect(row("a\\\\|b", "")).toMatch(/^\| `a\\\\\\\|b` \|/);
    expect(row("a`b", "")).toMatch(/^\| ``a`b`` \|/);
    expect(row("`a", "")).toMatch(/^\| `` `a `` \|/);
  });

  it("writes a GraphQL operation: its signature, arguments, the type it returns, the query and an answer", () => {
    const result = readGraphql(`type Query {\n  "A post by its id."\n  post(id: ID!): Post\n}\ntype Post {\n  id: ID!\n  title: String\n}\n`);
    if ("error" in result) throw new Error(result.error);
    const operation = result.doc.operations[0]!;
    const text = operationMarkdown(result.doc, operation);
    expect(text).toContain("# post\n\n`query post(id): Post`\n\nA post by its id.\n\n## Arguments\n\n| Name | Type | Required | Description |");
    expect(text).toContain("| `id` | ID! | Yes |");
    expect(text).toContain("## Returns\n\n`Post`");
    expect(text).toContain("| `title` | String | No |");
    expect(text).toContain("## Query\n\n```graphql\nquery");
    expect(text).toContain('## Response example\n\n```json\n{\n  "data": {\n    "post": {');
  });
});

describe("specHtml", () => {
  it("shows a placeholder written as a tag as its text, and keeps HTML's own tags", () => {
    expect(specHtml("The end of its address, /docs/<slug>.")).toBe("<p>The end of its address, /docs/&lt;slug&gt;.</p>\n");
    expect(specHtml("The <post id>, on <date>.")).toBe("<p>The &lt;post id&gt;, on &lt;date&gt;.</p>\n");
    expect(specHtml("One<br>two, <b>bold</b>, <kbd>Esc</kbd> <!-- note -->")).toBe("<p>One<br>two, <b>bold</b>, <kbd>Esc</kbd> <!-- note --></p>\n");
    expect(specHtml("<details>\n<summary>More</summary>\n\nText\n</details>")).toContain("<details>\n<summary>More</summary>");
    expect(specHtml("<SLUG>\nis the **address**.")).toBe("<p>&lt;SLUG&gt;\nis the <strong>address</strong>.</p>\n");
    expect(specHtml("- <slug>\n- two")).toBe("<ul>\n<li>&lt;slug&gt;</li>\n<li>two</li>\n</ul>\n");
    expect(specHtml("Run <code>make</code>, <b><!-- <b> -->bold</b>.")).toBe("<p>Run <code>make</code>, <b><!-- <b> -->bold</b>.</p>\n");
  });
});
