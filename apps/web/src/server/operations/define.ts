import { isDeepStrictEqual } from "node:util";

import { prisma, type TeamRole } from "@tuti/db";
import { z } from "zod";

/**
 * Every feature is an operation, defined once and served in tRPC (server/trpc/router.ts), the REST API and MCP, so the
 * surfaces can't drift apart. Who may run one is checked in one place (authorize), never inside its run.
 */

export type Scope = "read" | "write";

/**
 * Who's calling: someone signed in (in the app, on a portal, or in the widget by its token), a project's API key (acting
 * as its team), or a visitor nobody signed in: the widget's signed-out visitor by their visitor token's hash, or, with
 * none (null), someone reading a portal signed out. `sessionId`: the app session a teammate called the API with
 * (server/api-auth.ts), which a device they register belongs to. `viaWidget`: someone the customer's site signed in to
 * the widget, a reader whatever their role (the embedding site holds their token): never the team, in what they see
 * either. A visitor acts only where `access` is "reader".
 */
export type Actor =
  | { kind: "user"; userId: string; sessionId?: string; viaWidget?: true }
  | { kind: "apiKey"; keyId: string; projectId: string; scope: Scope; createdById: string }
  | { kind: "visitor"; visitorHash: string | null };
export type ApiKeyActor = Extract<Actor, { kind: "apiKey" }>;

/**
 * Who an actor acts as: the person signed in, or a key's creator. A visitor is nobody: refused (they run only `reader`
 * operations, and none of those asks this).
 */
export function actingUserId(actor: Actor): string {
  if (actor.kind === "visitor") {
    throw new OperationError(401, "unauthorized", "Sign in to do this");
  }
  return actor.kind === "user" ? actor.userId : actor.createdById;
}

/** What an operation runs with: who's calling and in which project, plus what trusted server code adds (`byItself`, `quietly`). */
export type Context = {
  actor: Actor;
  projectId: string;
  /** For `access: "owner"` operations: the owner acting (for a key, whoever created it), for recording who changed what. */
  ownerId?: string;
};

type Fields<I extends z.ZodType> = {
  /** Stable name, e.g. "posts.list" (MCP tool names and tRPC procedures derive from it). */
  name: string;
  /** A heading, at most 30 characters, verb first, plain text: "List posts" (the spec's `summary`, MCP's `title`). */
  title: string;
  /** One line for the API docs and MCP tool descriptions. */
  summary: string;
  /** Also its tRPC procedure's kind: GET is a query (it changes, starts and spends nothing), anything else a mutation. */
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /**
   * Needed by the app but not part of the public API (sessions, invitations, page-shaped reads): served in tRPC only,
   * never in REST, MCP or the docs, so `path` is optional.
   */
  internal?: boolean;
  /** REST path under /api/v1, with {params} taken from the input. Required unless `internal`. */
  path?: string;
  /** Read operations work with any key; write operations need a read + write key. */
  scope: Scope;
  /**
   * Who may run it: the project's team, only its owners and admins (project settings, like the Settings page), only its
   * owners (settings only they change, like Autopilot's: a key works only while whoever created it owns the project),
   * anyone signed in who may post in the project, or anyone who can read its portal, signed in or not (a visitor
   * too). Keys count as the team, with their creator's current role. Checked before the run, never inside it (authorize).
   */
  access: "team" | "admin" | "owner" | "anyone" | "reader";
  /**
   * The statuses besides those every operation may answer with (openapi.ts: `errorStatuses`) that its run, or a helper
   * it calls, can raise: 402 (its plan or credits), 404 (something its input names, where its path names nothing),
   * 409 (a conflict with how things are now), 502 (a service Tuti uses failed: the AI, Stripe, DNS, email), 503 (a
   * feature that isn't set up on this server).
   */
  errors?: (402 | 404 | 409 | 429 | 502 | 503)[];
  input: I;
  /**
   * What it returns, as JSON (dates as ISO strings): the spec's 200 response and MCP's `outputSchema`. Fields say what
   * they are with `.describe()` and show a value with `.meta({ examples: [...] })`; a type several operations return
   * gets `.meta({ id })`, its name in the spec. Under the tests every result is checked against it (checked).
   */
  output: z.ZodObject;
  /** An example request body or query, for the docs. */
  example?: Record<string, unknown>;
};

type Run<I extends z.ZodType, O> = (context: Context, input: z.infer<I>) => Promise<O>;

/** What defineOperation takes: the operation's fields and its run. */
export type OperationDefinition<I extends z.ZodType = z.ZodType, O = unknown> = Fields<I> &
  ({ internal?: false; path: string } | { internal: true; path?: string }) & { run: Run<I, O> };

/**
 * An operation as the rest of the code sees it: everything but its run, which only runOperation and procedureFor
 * reach. `~output` exists only as a type, so OutputOf can read it.
 */
export type Operation<I extends z.ZodType = z.ZodType, O = unknown> = Fields<I> & { readonly "~output"?: O };
/** One in the public API: REST, MCP and the docs. */
export type PublicOperation = Operation & { path: string; internal?: false };

/** What a caller sends an operation (before its input's defaults and transforms). */
export type InputOf<T> = T extends Operation<infer I, unknown> ? z.input<I> : never;
/** What an operation returns. */
export type OutputOf<T> = T extends { readonly "~output"?: infer O } ? O : never;

/** Each operation's run, out of reach: only the checked entry points below call it. */
const runs = new WeakMap<object, Run<z.ZodType, unknown>>();

type Method = Fields<z.ZodType>["method"];

/** Keeps the name and method as literal types, so lists of operations (like the matrices and the router) are checked by them. */
export function defineOperation<const N extends string, const M extends Method, I extends z.ZodType, O>(
  definition: Fields<I> & { name: N; method: M; internal?: false; path: string; run: Run<I, O> },
): Operation<I, O> & { name: N; method: M; internal?: false; path: string };
export function defineOperation<const N extends string, const M extends Method, I extends z.ZodType, O>(
  definition: Fields<I> & { name: N; method: M; internal: true; run: Run<I, O> },
): Operation<I, O> & { name: N; method: M; internal: true };
export function defineOperation<I extends z.ZodType, O>(definition: OperationDefinition<I, O>): Operation<I, O> {
  const { run, ...operation } = definition;
  runs.set(operation, (process.env.VITEST ? checked(definition) : run) as Run<z.ZodType, unknown>);
  return operation;
}

function runOf<I extends z.ZodType, O>(operation: Operation<I, O>): Run<I, O> {
  const run = runs.get(operation);
  if (!run) {
    throw new Error(`${operation.name} isn't an operation defineOperation returned`);
  }
  return run as Run<I, O>;
}

/**
 * In tests, a run whose result isn't what its output says fails: every field it declares, of its type, and none it
 * doesn't (parsing drops those, so the parsed result would differ). So every test that runs an operation, not only the
 * operations matrix, keeps the spec and MCP's outputSchema whole. Exported for define.test.ts alone.
 */
export function checked<I extends z.ZodType, O>(operation: OperationDefinition<I, O>): Run<I, O> {
  return async (context, input) => {
    const result = await operation.run(context, input);
    const body = JSON.parse(JSON.stringify(result)) as unknown;
    const parsed = operation.output.safeParse(body);
    if (!parsed.success || !isDeepStrictEqual(parsed.data, body)) {
      throw new Error(
        `${operation.name} returned what its output doesn't say: ${parsed.success ? "fields it doesn't declare" : z.prettifyError(parsed.error)}\n${JSON.stringify(body).slice(0, 2000)}`,
      );
    }
    return result;
  };
}

/** An expected failure, with the HTTP status the API answers with. */
export class OperationError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 429 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Someone's role on a project's team now, or null. */
const roleIn = async (projectId: string, userId: string) =>
  (await prisma.teamMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { role: true } }))?.role ?? null;

/**
 * Whether the actor may run the operation in the project: the one check, used by the tRPC middleware (through
 * procedureFor) and by runOperation. A key's scope decides reads and writes, and it acts with its creator's current role
 * (none once they left the team); `team`, `admin` and `owner` need that role; `anyone` needs someone signed in who may
 * act in the project (canActIn: not another project's single sign-on user, a reader of a private portal); `reader`
 * needs someone who can read the project's portal (`mayRead`: the middleware's answer for the request's reader, its
 * preview and widget cookies included; else the actor's), and a key counts as the team. A visitor (nobody signed in)
 * acts only where `access` is `reader`. `role`: the actor's, when the caller already read it. Returns the context to run
 * with (with `ownerId` for owner operations).
 */
export async function authorize<C extends Context>(
  operation: Pick<Operation, "scope" | "access">,
  context: C,
  role?: TeamRole | null,
  mayRead?: () => Promise<boolean>,
): Promise<C> {
  const { actor, projectId } = context;
  // Imported here: portal-readers.ts reaches the session, and membership.ts reaches operations, which import this file.
  const canRead = async (userId: string | null) => (await import("../auth/portal-readers")).canReadPortal({ id: projectId }, userId);
  const refusedReader = () => new OperationError(403, "forbidden", "This portal is private: sign in as one of its readers");
  if (actor.kind === "visitor") {
    if (operation.access !== "reader") {
      throw new OperationError(401, "unauthorized", "Sign in to do this");
    }
    if (!(await (mayRead ?? (() => canRead(null)))())) {
      throw refusedReader();
    }
    return context;
  }
  const userId = actor.kind === "user" ? actor.userId : actor.createdById;
  if (actor.kind === "apiKey") {
    if (actor.projectId !== projectId) {
      throw new OperationError(403, "forbidden", "This key is for another project");
    }
    if (operation.scope === "write" && actor.scope === "read") {
      throw new OperationError(403, "forbidden", "This key can only read. Create a read + write key to change things.");
    }
  }
  const needsRole = actor.kind === "apiKey" || (operation.access !== "anyone" && operation.access !== "reader");
  const current = needsRole ? (role === undefined ? await roleIn(projectId, userId) : role) : null;
  if (needsRole && !current) {
    throw new OperationError(403, "forbidden", actor.kind === "apiKey" ? "This API key stopped working when whoever created it left the team" : "You're not on this project's team");
  }
  if (operation.access === "reader" && actor.kind === "user" && !(await (mayRead ?? (() => canRead(userId)))())) {
    throw refusedReader();
  }
  if (operation.access === "anyone" && actor.kind === "user" && !(await (await import("../membership")).canActIn(userId, projectId))) {
    throw new OperationError(403, "forbidden", "You can't do this in this project");
  }
  if (operation.access === "admin" && current !== "OWNER" && current !== "ADMIN") {
    throw new OperationError(
      403,
      "forbidden",
      actor.kind === "apiKey" ? "This key's creator is no longer a project owner or admin, so it can't use project settings" : "Only project owners and admins can use project settings",
    );
  }
  if (operation.access === "owner") {
    if (current !== "OWNER") {
      throw new OperationError(403, "forbidden", "Only project owners can change this");
    }
    return { ...context, ownerId: userId };
  }
  return context;
}

/** Checks an operation's input as the app's calls always have (operations/run.ts: call): 400 with its first issue. */
function parsed<I extends z.ZodType>(operation: Operation<I, unknown>, input: unknown): z.infer<I> {
  const result = operation.input.safeParse(input);
  if (!result.success) {
    throw new OperationError(400, "invalid_input", result.error.issues[0]?.message ?? "Invalid input");
  }
  return result.data;
}

/**
 * For trusted server code already past the check: an operation running another (approving a code change writes a
 * comment), a job acting for a stated actor. Keeps the context it's given (`byItself`, `quietly`), but still checks the
 * inner operation's input and its own access, scope and owner rule against that actor, so an outer operation can
 * never do what its caller couldn't do directly.
 */
export async function runOperation<I extends z.ZodType, O>(operation: Operation<I, O>, context: Context, input: z.input<I>): Promise<O> {
  const data = parsed(operation, input);
  return runOf(operation)(await authorize(operation, context), data);
}

/**
 * What the tRPC router builds each operation's procedure from: the same check as runOperation, before the input is
 * read (so a refused caller hears that, whatever they sent, as REST always answered), then the run with what it
 * returned. `role` is the caller's, which the middleware read, and `mayRead` whether the request's reader can read the
 * portal (for `reader` operations); the input arrives checked (the procedure's parser).
 */
export function procedureFor<I extends z.ZodType, O>(operation: Operation<I, O>) {
  const run = runOf(operation);
  return async (context: Context, role?: TeamRole | null, mayRead?: () => Promise<boolean>) => {
    const allowed = await authorize(operation, context, role, mayRead);
    return (input: z.infer<I>): Promise<O> => run(allowed, input);
  };
}

/**
 * The run with no access or scope check, for the one caller that checks for itself until it moves onto the router:
 * operations/run.ts's `call` (until T12, which deletes this). Only the owner rule is applied here, as it used to be
 * inside those runs. A test keeps it to that caller.
 */
export async function legacyRun<I extends z.ZodType, O>(operation: Operation<I, O>, context: Context, input: z.infer<I>): Promise<O> {
  const owned = operation.access === "owner" ? await authorize({ scope: "read", access: "owner" }, context) : context;
  return runOf(operation)(owned, input);
}
