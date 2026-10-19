import type { z } from "zod";

/**
 * Every feature is an operation, defined once and exposed in the REST API (and,
 * next, MCP and the app's server actions), so the surfaces can't drift apart.
 */

export type Scope = "read" | "write";

/** Who's calling. An API key acts for its project. (Next: people in the app, keys on behalf of a project's user.) */
export type Actor = { kind: "apiKey"; keyId: string; projectId: string; scope: Scope };

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
  input: I;
  run: (context: { actor: Actor; projectId: string }, input: z.infer<I>) => Promise<O>;
};

export const defineOperation = <I extends z.ZodType, O>(operation: Operation<I, O>) => operation;

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
