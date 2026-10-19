import type { z } from "zod";

/**
 * Every feature is an operation, defined once and exposed in the REST API (and,
 * next, MCP and the app's server actions), so the surfaces can't drift apart.
 */

export type Scope = "read" | "write";

/** Who's calling: someone signed in (in the app or on a portal), or a project's API key (acting as its team). */
export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "apiKey"; keyId: string; projectId: string; scope: Scope; createdById: string };
export type ApiKeyActor = Extract<Actor, { kind: "apiKey" }>;

export type Operation<I extends z.ZodType = z.ZodType, O = unknown> = {
  /** Stable name, e.g. "posts.list" (MCP tool names derive from it). */
  name: string;
  /** One line for the API docs and MCP tool descriptions. */
  summary: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** REST path under /api/v1, with {params} taken from the input. */
  path: string;
  /** Read operations work with any key; write operations need a read + write key. */
  scope: Scope;
  /** Who may run it when signed in: the project's team, or anyone who may post in the project. Keys count as the team. */
  access: "team" | "anyone";
  input: I;
  /** An example request body or query, for the docs. */
  example?: Record<string, unknown>;
  run: (context: { actor: Actor; projectId: string }, input: z.infer<I>) => Promise<O>;
};

/** Keeps the name as a literal type, so lists of operations (like the authorization matrix) are checked by name. */
export const defineOperation = <const N extends string, I extends z.ZodType, O>(operation: Operation<I, O> & { name: N }) =>
  operation;

/** An expected failure, with the HTTP status the API answers with. */
export class OperationError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
