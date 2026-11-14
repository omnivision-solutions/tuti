import { PrismaPg } from "@prisma/adapter-pg";
import { pictureUrl } from "@tuti/shared/media-links";
import { effectivePlan } from "@tuti/shared/plans";

import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export { listen } from "./listen";

/** The NOTIFY channel of the support inbox's live updates (apps/web/src/server/live.ts). */
export const INBOX_CHANNEL = "tuti_inbox";

function createPrismaClient(): PrismaClient {
  // No connection is opened until the first query, so a missing URL only fails
  // at query time. Apps validate DATABASE_URL on startup instead (builds don't
  // need it).
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const relations = relationsOf(client);
  const pictures = withPictures(relations);
  return client.$extends({
    // A profile picture is saved as its stored file and signature (or, from elsewhere, its address): read as a link.
    // A project's plan is read as the one it's on (its trial's while that runs: withTrials).
    // On the results as they come, not as a result extension, whose objects carry a symbol React won't pass to the browser.
    query: {
      $allModels: {
        $allOperations: async ({ model, operation, args, query }) => {
          if (!model || ["count", "aggregate", "groupBy"].includes(operation)) {
            return pictures(model, await query(args));
          }
          const trials = withTrials(relations, model, args);
          return pictures(model, trials.fix(await query(trials.args as typeof args)));
        },
      },
    },
    // Typed as the plain client: the extension changes the field's value, not its type (string | null), and code
    // across the apps types transactions as Prisma.TransactionClient, which an extended client's type isn't.
  }) as unknown as PrismaClient;
}

type Relations = Record<string, Record<string, string>>;

/** Each model's relation fields and the model they hold, from the schema the client was generated from. */
function relationsOf(client: PrismaClient): Relations {
  const models = (client as unknown as { _runtimeDataModel?: { models?: Record<string, { fields: { name: string; kind: string; type: string }[] }> } })
    ._runtimeDataModel?.models;
  // Prisma's own, not public: if an upgrade moves it, fail at once rather than show every saved picture broken.
  if (!models?.User) {
    throw new Error("Prisma's data model isn't where @tuti/db reads it: pictures can't be read as links");
  }
  return Object.fromEntries(
    Object.entries(models).map(([model, { fields }]) => [model, Object.fromEntries(fields.filter((field) => field.kind === "object").map((field) => [field.name, field.type]))]),
  );
}

/**
 * A result with each user's picture as a link (pictureUrl): users at any depth, through relations only, so a JSON
 * value (a document, a user's properties) is never touched, whatever keys it has.
 */
function withPictures(relations: Relations) {
  const visit = (model: string, value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(model, item));
    } else if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (model === "User" && typeof row.image === "string") {
        row.image = pictureUrl(row.image);
      }
      for (const [field, related] of Object.entries(relations[model] ?? {})) {
        visit(related, row[field]);
      }
    }
  };
  return <T>(model: string | undefined, result: T): T => {
    if (model) {
      visit(model, result);
    }
    return result;
  };
}

type Fields = Record<string, unknown>;

/**
 * A query's arguments that read Project.trialEndsAt wherever they read a project's `plan`, and what turns its result's
 * plans into the plans in effect (effectivePlan: the trial's while it runs), at any depth through relations; the
 * trialEndsAt added is taken off again. A select naming trialEndsAt itself reads the plan as stored (Billing, buying a
 * plan, the trial banner).
 */
function withTrials(relations: Relations, model: string, args: unknown): { args: unknown; fix: <T>(result: T) => T } {
  const fixes: ((row: Fields) => void)[] = [];
  const query = (args ?? {}) as { select?: Fields; include?: Fields };
  const key = query.select ? "select" : query.include ? "include" : null;
  const fields = key ? query[key]! : {};
  const copy = { ...fields };
  // A whole row (no select) has both.
  const whole = key !== "select";
  const added = model === "Project" && !whole && Boolean(fields.plan) && !fields.trialEndsAt;
  const ownPlan = model === "Project" && !whole && Boolean(fields.trialEndsAt);
  if (added) {
    copy.trialEndsAt = true;
  }
  if (model === "Project" && !ownPlan) {
    fixes.push((row) => {
      if ("plan" in row && row.trialEndsAt !== undefined) {
        row.plan = effectivePlan(row.plan as string | null, row.trialEndsAt as Date | null);
      }
      if (added) {
        delete row.trialEndsAt;
      }
    });
  }
  for (const [field, related] of Object.entries(relations[model] ?? {})) {
    const value = fields[field];
    if (value) {
      const inner = withTrials(relations, related, value === true ? {} : value);
      if (value !== true) {
        copy[field] = inner.args;
      }
      fixes.push((row) => {
        inner.fix(row[field]);
      });
    }
  }
  const fix = <T>(result: T): T => {
    for (const row of Array.isArray(result) ? result : [result]) {
      if (row && typeof row === "object") {
        fixes.forEach((apply) => apply(row as Fields));
      }
    }
    return result;
  };
  return { args: key ? { ...query, [key]: copy } : args, fix };
}

// Reuse one client across hot reloads in dev so we don't exhaust connections.
// After `prisma generate` the generated module (and so the PrismaClient class)
// is reloaded; the cached client would lack new models, so replace it then.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaClass?: typeof PrismaClient;
};

function getPrismaClient(): PrismaClient {
  const cached = globalForPrisma.prisma;
  if (cached && globalForPrisma.prismaClass === PrismaClient) {
    return cached;
  }
  void cached?.$disconnect();
  return createPrismaClient();
}

export const prisma = getPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaClass = PrismaClient;
}
