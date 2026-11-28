import type { TRPCMutationProcedure, TRPCQueryProcedure } from "@trpc/server";

import { all, allOperations } from "../operations";
import { type InputOf, type Operation, OperationError, type OutputOf, procedureFor } from "../operations/define";
import { type ProjectField, projectOf, router, signedInProcedure } from "./init";

/**
 * The router, generated from the operations list (docs/plan.md, "One way in"): one procedure per operation, under its
 * name (`aiFirst.update` is `trpc.aiFirst.update`), a query exactly when its method is GET, else a mutation. Nobody
 * writes a procedure by hand.
 */

type Any = (typeof all)[number];
type Meta = object;
/** An operation's input with the project's slug; one that takes nothing takes only that (zod's `{}` is `Record<string, never>`). */
type InputWithProject<Op> = (string extends keyof InputOf<Op> ? unknown : InputOf<Op>) & ProjectField;
type ProcedureOf<Op> = Op extends { method: "GET" }
  ? TRPCQueryProcedure<{ meta: Meta; input: InputWithProject<Op>; output: OutputOf<Op> }>
  : TRPCMutationProcedure<{ meta: Meta; input: InputWithProject<Op>; output: OutputOf<Op> }>;
type Groups = Any["name"] extends infer N ? (N extends `${infer G}.${string}` ? G : never) : never;
type Procedures = { [G in Groups]: { [Op in Any as Op["name"] extends `${G}.${infer P}` ? P : never]: ProcedureOf<Op> } };

/** The input a procedure takes: its operation's, without the project's slug (read before it, below). */
function inputOf(operation: Operation) {
  return (raw: unknown) => {
    const rest: Record<string, unknown> = { ...(raw ?? {}) };
    delete rest.project;
    const parsed = operation.input.safeParse(rest);
    if (!parsed.success) {
      throw new OperationError(400, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
    }
    return parsed.data as unknown;
  };
}

function procedure(operation: Operation) {
  const allowed = procedureFor(operation);
  const built = signedInProcedure
    .use(async ({ ctx, getRawInput, next }) => {
      // Who may, before the input is checked (as REST always answered): a typo in the slug or a refusal, then the input.
      const { project } = ((await getRawInput()) ?? {}) as { project?: unknown };
      const { actor, projectId, role } = await projectOf(ctx, typeof project === "string" ? project : undefined, operation.access);
      return next({ ctx: { run: await allowed({ actor, projectId }, role) } });
    })
    .input(inputOf(operation));
  const resolve = ({ ctx, input }: { ctx: { run: (input: unknown) => Promise<unknown> }; input: unknown }) => ctx.run(input);
  return operation.method === "GET" ? built.query(resolve) : built.mutation(resolve);
}

const record: { [group: string]: { [name: string]: ReturnType<typeof procedure> } } = {};
for (const operation of allOperations) {
  const [group, name] = operation.name.split(".") as [string, string];
  (record[group] ??= {})[name] = procedure(operation);
}

export const appRouter = router(record as unknown as Procedures);
export type AppRouter = typeof appRouter;
