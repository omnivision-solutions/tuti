import { describe, expect, it } from "vitest";
import { type ApiReferenceState, onHelpCenter, readSpec, settle } from "./settle";
import type { ApiDoc, ApiOperation, ApiSchema, ApiType } from "./types";

function doc(over: Partial<ApiDoc> = {}): ApiDoc {
  return { format: "openapi", title: "Acme", version: "1", description: "", servers: [], auth: [], groups: [], operations: [], types: [], warnings: [], ...over };
}

function operation(key: string, over: Partial<ApiOperation> = {}): ApiOperation {
  const [kind, path] = key.split(" ") as [ApiOperation["kind"], string];
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { key, slug, group: "Posts", kind, path, title: key, description: "", deprecated: false, auth: [], params: [], body: null, responses: [], ...over };
}

const group = (key: string) => ({ key, name: key, description: "" });
const type = (name: string, schema: ApiSchema = { type: "object" }): ApiType => ({ name, slug: name.toLowerCase(), kind: "object", schema });
const returns = (ref: string) => ({ responses: [{ status: "200", description: "", contentType: "application/json", schema: { type: ref, ref } }] });

const posts = doc({ groups: [group("Posts"), group("Admin")], operations: [operation("GET /posts"), operation("DELETE /posts", { group: "Admin" })] });
const slugsOf = (settled: { doc: ApiDoc }) => Object.fromEntries([...settled.doc.operations.map((o) => [o.key, o.slug]), ...settled.doc.types.map((t) => [t.name, t.slug])]);
const hide = (settled: { doc: ApiDoc; state: ApiReferenceState }, state: Partial<ApiReferenceState>) => ({ doc: settled.doc, state: { ...settled.state, ...state } });

describe("readSpec", () => {
  const openapi = { openapi: "3.1.0", info: { title: "Acme", version: "1" }, paths: { "/posts": { get: { summary: "List posts" } } } };
  const sdl = "type Query {\n  posts: [String]\n}\n";
  const introspection = {
    __schema: {
      queryType: { name: "Query" },
      types: [
        { kind: "OBJECT", name: "Query", fields: [{ name: "posts", args: [], type: { kind: "SCALAR", name: "String" } }], interfaces: [] },
        { kind: "SCALAR", name: "String" },
      ],
      directives: [],
    },
  };

  it.each([
    ["OpenAPI as JSON", JSON.stringify(openapi), "openapi"],
    ["OpenAPI as YAML", "openapi: 3.0.0\ninfo:\n  title: Acme\n  version: '1'\npaths:\n  /posts:\n    get:\n      summary: List posts\n", "openapi"],
    ["a GraphQL schema file", sdl, "graphql"],
    ["a schema file on one line, which is a YAML mapping too", "type Query { posts: String }", "graphql"],
    ["an introspection result", JSON.stringify(introspection), "graphql"],
    ["an endpoint's whole answer", JSON.stringify({ data: introspection }), "graphql"],
  ])("reads %s", (_, text, format) => {
    const read = readSpec(text);
    expect("doc" in read && read.doc.format).toBe(format);
    expect("doc" in read && read.doc.operations).toHaveLength(1);
  });

  it("gives a GraphQL doc its endpoint", () => {
    const read = readSpec(sdl, { endpoint: "https://api.example.com/graphql" });
    expect("doc" in read && read.doc.servers.map((server) => server.url)).toEqual(["https://api.example.com/graphql"]);
  });

  it("says what's wrong in the reader's words", () => {
    expect(readSpec(JSON.stringify({ name: "package" }))).toEqual({ error: expect.stringContaining("isn't an OpenAPI spec") });
    expect(readSpec("name: package\nversion: 1\n")).toEqual({ error: expect.stringContaining("isn't an OpenAPI spec") });
    expect(readSpec("hello there")).toEqual({ error: expect.stringContaining("isn't a GraphQL schema file") });
    expect(readSpec("")).toEqual({ error: expect.any(String) });
    expect(readSpec("x".repeat(5 * 1024 * 1024 + 1))).toEqual({ error: expect.stringContaining("5 MB") });
  });
});

describe("settle", () => {
  it("a first read hides nothing, marks nothing new and orders the groups as the spec does", () => {
    const { doc: settled, state } = settle(null, posts);
    expect(settled).toEqual(posts);
    expect(state).toEqual({
      slugs: { "GET /posts": "get-posts", "DELETE /posts": "delete-posts" },
      hiddenOperations: [],
      hiddenGroups: [],
      unseen: [],
      groupOrder: ["Posts", "Admin"],
    });
  });

  it("a reworded summary keeps the page's address, and a type keeps its by name", () => {
    const first = settle(null, doc({ operations: [operation("GET /posts", { slug: "list-posts" })], types: [{ ...type("Post"), slug: "post" }] }));
    const again = settle(first, doc({ operations: [operation("GET /posts", { slug: "list-all-posts", title: "List all posts" })], types: [{ ...type("Post"), slug: "post-2" }] }));
    expect(slugsOf(again)).toEqual({ "GET /posts": "list-posts", Post: "post" });
    expect(again.doc.operations[0]!.title).toBe("List all posts");
  });

  it("a new operation or type proposing a kept slug gets a number", () => {
    const first = settle(null, doc({ operations: [operation("GET /posts", { slug: "posts" })], types: [{ ...type("Post"), slug: "post" }] }));
    const again = settle(
      first,
      doc({
        // The reader numbers in the spec's order, so the one that was there first now proposes another.
        operations: [operation("GET /v2/posts", { slug: "posts" }), operation("GET /posts", { slug: "posts-2" }), operation("GET /post", { slug: "post" })],
        types: [{ ...type("Post"), slug: "post-2" }, { ...type("Posts"), slug: "posts-3" }],
      }),
    );
    expect(slugsOf(again)).toEqual({ "GET /v2/posts": "posts-2", "GET /posts": "posts", "GET /post": "post-2", Post: "post", Posts: "posts-3" });
    expect(new Set(Object.values(slugsOf(again))).size).toBe(5);
  });

  it("an operation that left the spec comes back where and as it was", () => {
    const first = hide(settle(null, posts), { hiddenOperations: ["DELETE /posts"] });
    const without = settle(first, doc({ groups: [group("Posts")], operations: [operation("GET /posts"), operation("GET /users", { slug: "delete-posts" })] }));
    expect(slugsOf(without)).toEqual({ "GET /posts": "get-posts", "GET /users": "delete-posts-2" });
    const back = settle(without, posts);
    expect(slugsOf(back)).toEqual({ "GET /posts": "get-posts", "DELETE /posts": "delete-posts" });
    expect(back.state.hiddenOperations).toContain("DELETE /posts");
    expect(back.state.groupOrder).toEqual(["Posts", "Admin"]);
  });

  it("what a read adds is new, and on the help center while nothing is hidden", () => {
    const again = settle(settle(null, posts), doc({ ...posts, operations: [...posts.operations, operation("POST /posts")] }));
    expect(again.state.unseen).toEqual(["POST /posts"]);
    expect(again.state.hiddenOperations).toEqual([]);
    // Another read with no visit between keeps it new; one without it forgets it.
    expect(settle(again, again.doc).state.unseen).toEqual(["POST /posts"]);
    expect(settle(again, posts).state.unseen).toEqual([]);
  });

  it("a renamed tag and a moved path start hidden once anything is hidden", () => {
    const first = hide(settle(null, posts), { hiddenGroups: ["Admin"] });
    const renamed = doc({
      groups: [group("Posts"), group("Internal")],
      operations: [operation("GET /posts"), operation("DELETE /posts", { group: "Internal" }), operation("DELETE /internal/posts", { group: "Internal" })],
    });
    const again = settle(first, renamed);
    // The operation that only changed its tag was there before: it isn't new, and it stays off, hidden by itself.
    expect(again.state.unseen).toEqual(["DELETE /internal/posts"]);
    expect(again.state.hiddenOperations).toEqual(["DELETE /internal/posts", "DELETE /posts"]);
    expect(again.state.hiddenGroups).toEqual(["Admin"]);
    expect(onHelpCenter(again.doc, again.state).operations.map((o) => o.key)).toEqual(["GET /posts"]);
    // Read again, nothing more is hidden; and the tag's old name coming back opens nothing.
    expect(settle(again, renamed).state).toEqual(again.state);
    expect(onHelpCenter(settle(again, posts).doc, settle(again, posts).state).operations.map((o) => o.key)).toEqual(["GET /posts"]);

    const moved = settle(hide(settle(null, posts), { hiddenOperations: ["DELETE /posts"] }), doc({ ...posts, operations: [operation("GET /posts"), operation("DELETE /v2/posts", { group: "Admin" })] }));
    expect(moved.state.hiddenOperations).toEqual(["DELETE /posts", "DELETE /v2/posts"]);
    expect(onHelpCenter(moved.doc, moved.state).operations.map((o) => o.key)).toEqual(["GET /posts"]);
  });

  it("keeps the team's order of the groups, new ones after them", () => {
    const first = hide(settle(null, posts), { groupOrder: ["Admin", "Posts"] });
    const again = settle(first, doc({ groups: [group("Users"), group("Posts"), group("Admin")], operations: posts.operations }));
    expect(again.state.groupOrder).toEqual(["Admin", "Posts", "Users"]);
  });
});

describe("onHelpCenter", () => {
  const state = (over: Partial<ApiReferenceState> = {}): ApiReferenceState => ({ slugs: {}, hiddenOperations: [], hiddenGroups: [], unseen: [], groupOrder: [], ...over });

  it("leaves out hidden operations, those in a hidden group or tagged with one, and groups with nothing left", () => {
    const all = doc({
      groups: [group("Posts"), group("Admin"), group("Users")],
      operations: [
        operation("GET /posts"),
        operation("POST /posts", { alsoIn: ["Admin"] }),
        operation("DELETE /posts", { group: "Admin" }),
        operation("GET /users", { group: "Users" }),
      ],
    });
    expect(onHelpCenter(all, state()).operations).toHaveLength(4);
    const shown = onHelpCenter(all, state({ hiddenGroups: ["Admin"], hiddenOperations: ["GET /users"], groupOrder: ["Users", "Admin", "Posts"] }));
    expect(shown.operations.map((o) => o.key)).toEqual(["GET /posts"]);
    expect(shown.groups.map((g) => g.key)).toEqual(["Posts"]);
  });

  it("lists the groups in the team's order, the ones it doesn't name after them", () => {
    const all = doc({ groups: [group("A"), group("B"), group("C"), group("D")], operations: ["A", "B", "C", "D"].map((key) => operation(`GET /${key}`, { group: key })) });
    expect(onHelpCenter(all, state({ groupOrder: ["C", "A"] })).groups.map((g) => g.key)).toEqual(["C", "A", "B", "D"]);
  });

  it("includes a type only while an operation on the help center uses it, itself or through another type", () => {
    const all = doc({
      groups: [group("Posts"), group("Admin")],
      operations: [
        operation("GET /posts", { ...returns("Post"), params: [{ name: "sort", in: "query", required: false, description: "", schema: { type: "Sort", ref: "Sort" } }] }),
        operation("POST /posts", { body: { required: true, contentType: "application/json", schema: { type: "array of NewPost", items: { type: "NewPost", ref: "NewPost" } }, example: null } }),
        operation("GET /audit", { group: "Admin", ...returns("AuditEntry") }),
      ],
      types: [
        // Reached only through Post, then through Author; and it names Post again (a loop).
        type("Team", { type: "object", properties: [{ name: "posts", required: false, type: "array of Post", items: { type: "Post", ref: "Post" } }] }),
        type("Post", { type: "object", properties: [{ name: "author", required: true, type: "Author", ref: "Author" }] }),
        type("Author", { type: "object", oneOf: [{ type: "Team", ref: "Team" }] }),
        type("Sort"),
        type("NewPost"),
        type("AuditEntry", { type: "object", properties: [{ name: "secret", required: true, type: "Secret", ref: "Secret" }] }),
        type("Secret"),
        type("Unused"),
      ],
    });
    expect(onHelpCenter(all, state()).types.map((t) => t.name)).toEqual(["Team", "Post", "Author", "Sort", "NewPost", "AuditEntry", "Secret"]);
    // Used only by hidden operations: neither it nor what only it names.
    expect(onHelpCenter(all, state({ hiddenGroups: ["Admin"] })).types.map((t) => t.name)).toEqual(["Team", "Post", "Author", "Sort", "NewPost"]);
    expect(onHelpCenter(all, state({ hiddenOperations: ["GET /posts"] })).types.map((t) => t.name)).toEqual(["NewPost", "AuditEntry", "Secret"]);
  });

  it("shows what a read adds once nothing the team can see is hidden, whatever keys are kept", () => {
    // A hidden tag is renamed, its operation shown again: the old tag's key is kept, and hides nothing.
    const first = hide(settle(null, posts), { hiddenGroups: ["Admin"] });
    const renamed = settle(first, doc({ groups: [group("Posts"), group("Internal")], operations: [operation("GET /posts"), operation("DELETE /posts", { group: "Internal" })] }));
    expect(renamed.state.hiddenOperations).toEqual(["DELETE /posts"]);
    const shown = hide(renamed, { hiddenOperations: [] });
    expect(shown.state.hiddenGroups).toEqual(["Admin"]);
    const more = settle(shown, doc({ ...shown.doc, operations: [...shown.doc.operations, operation("GET /comments")] }));
    expect(onHelpCenter(more.doc, more.state).operations.map((o) => o.key)).toContain("GET /comments");

    // A hidden operation leaves the spec: its key is kept (it comes back hidden), and hides nothing meanwhile.
    const hidden = hide(settle(null, posts), { hiddenOperations: ["DELETE /posts"] });
    const gone = settle(hidden, doc({ groups: [group("Posts")], operations: [operation("GET /posts")] }));
    const grown = settle(gone, doc({ groups: [group("Posts")], operations: [operation("GET /posts"), operation("GET /comments")] }));
    expect(onHelpCenter(grown.doc, grown.state).operations.map((o) => o.key)).toEqual(["GET /posts", "GET /comments"]);
    const back = settle(grown, doc({ ...grown.doc, groups: posts.groups, operations: [...grown.doc.operations, operation("DELETE /posts", { group: "Admin" })] }));
    expect(onHelpCenter(back.doc, back.state).operations.map((o) => o.key)).not.toContain("DELETE /posts");
  });
});
