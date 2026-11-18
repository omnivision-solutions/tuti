import { describe, expect, it } from "vitest";

import { readGraphql } from "./graphql";
import { operationMarkdown } from "./markdown";
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
