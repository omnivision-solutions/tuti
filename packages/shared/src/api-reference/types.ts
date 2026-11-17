/**
 * What a team's API spec becomes once read: one shape for OpenAPI and GraphQL, so the help
 * center's pages, the docs' tree, the request console and the team's settings read the same thing
 * whichever format the spec is in. A reader (one per format) makes it; nothing else reads a spec.
 * It's stored as JSON, so everything in it is plain data.
 */
export type ApiDoc = {
  format: "openapi" | "graphql";
  /** The API's name (OpenAPI's `info.title`); empty when the spec has none. */
  title: string;
  version: string | null;
  /** Markdown. */
  description: string;
  /** Where requests go, the first one by default. GraphQL: its one endpoint, when known. */
  servers: { url: string; description: string }[];
  /** Every way of signing a request the spec declares; an operation names the ones it takes. */
  auth: ApiAuth[];
  /** In the spec's order: OpenAPI's tags (operations without one are in "Other"); GraphQL's Queries, Mutations and Subscriptions. */
  groups: ApiGroup[];
  operations: ApiOperation[];
  /** Named schemas (OpenAPI's components) or types (GraphQL's), each with a page under the operations. */
  types: ApiType[];
  /** What the reader left out or guessed: the pages are still built. */
  warnings: ApiWarning[];
};

export type ApiAuth = {
  /** Its name in the spec (a security scheme's key). */
  key: string;
  kind: "bearer" | "basic" | "header" | "query" | "cookie" | "oauth2" | "openIdConnect";
  /** The header, query parameter or cookie that carries it ("Authorization" for bearer and basic). */
  name: string;
  description: string;
};

export type ApiGroup = {
  /** Its name as a slug: what the team's order and switches go by. No two in a doc share one (the later gets a number). */
  key: string;
  name: string;
  /** Markdown. */
  description: string;
};

export type ApiOperation = {
  /**
   * What it is across re-reads of the spec, so the team's choices about it stay: "POST /posts",
   * "mutation createPost". Not its slug, which follows its title.
   */
  key: string;
  /**
   * Its page's address under the reference, from its title; no operation or type in a doc shares
   * one. A reader only proposes it: an operation the reference has seen before (by `key`) keeps the
   * slug it first had, so rewording a summary moves no page.
   */
  slug: string;
  /** Its group's key. */
  group: string;
  kind: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE" | "query" | "mutation" | "subscription";
  /** OpenAPI: the path with its parameters ("/posts/{number}"). GraphQL: the field's name. */
  path: string;
  /** OpenAPI: the summary, else the operation's id in words, else its method and path. GraphQL: the field's name. */
  title: string;
  /** Markdown. */
  description: string;
  deprecated: boolean;
  /** The keys of the ways it can be signed (any one of them); none: it needs no signing. */
  auth: string[];
  /** OpenAPI: path, query, header and cookie parameters. GraphQL: the field's arguments. */
  params: ApiParam[];
  /** OpenAPI only: the request's body, in its first content type. */
  body: { required: boolean; contentType: string; schema: ApiSchema; example: unknown } | null;
  /** OpenAPI: each status in the spec's order ("200", "default"). GraphQL: one, `status` "data", its schema the type returned. */
  responses: ApiResponse[];
  /** GraphQL only: the operation to send, with the variables it takes. */
  query?: { text: string; variables: Record<string, unknown> };
};

export type ApiParam = {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "argument";
  required: boolean;
  /** Markdown. */
  description: string;
  schema: ApiSchema;
  example?: unknown;
};

export type ApiResponse = {
  status: string;
  description: string;
  contentType: string | null;
  schema: ApiSchema | null;
  /** The spec's example, else one made from the schema; undefined without a body. */
  example?: unknown;
};

/**
 * A value's type as the pages show it. A named type (`ref`) is spelled out where it's first met and
 * two levels down from there; deeper, and wherever it would contain itself, it's only named, and its
 * own page has the rest.
 */
export type ApiSchema = {
  /** For reading: "string", "integer", "array of Post", "CreatePostInput!". */
  type: string;
  /** The named type it is, when it's one of `ApiDoc.types`. */
  ref?: string;
  /** Markdown. */
  description?: string;
  nullable?: boolean;
  deprecated?: boolean;
  format?: string;
  /** Limits in words: "3–200 characters", "at least 1". */
  constraints?: string;
  enum?: string[];
  default?: unknown;
  /** An object's fields, in the spec's order. */
  properties?: ApiProperty[];
  /** An array's items. */
  items?: ApiSchema;
  /** One of several shapes (OpenAPI's oneOf and anyOf, GraphQL's unions and interfaces). */
  oneOf?: ApiSchema[];
};

export type ApiProperty = ApiSchema & { name: string; required: boolean };

export type ApiType = {
  name: string;
  /** Its page's address under the reference; no type or operation in a doc shares one. */
  slug: string;
  kind: "object" | "input" | "enum" | "scalar" | "union" | "interface";
  schema: ApiSchema;
};

export type ApiWarning = {
  /** The kind of problem, in capitals with underscores ("UNKNOWN_REF"): warnings of one kind are shown together. */
  code: string;
  /** The problem in a sentence, the same for every warning of its kind. */
  message: string;
  /** Where in the spec, for reading: "POST /posts › responses › 400". */
  where: string;
};
