import { PrismaPg } from "@prisma/adapter-pg";
import { pictureUrl } from "@tuti/shared/media-links";

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
  const pictures = withPictures(relationsOf(client));
  return client.$extends({
    // A profile picture is saved as its stored file and signature (or, from elsewhere, its address): read as a link.
    // On the results as they come, not as a result extension, whose objects carry a symbol React won't pass to the browser.
    query: { $allModels: { $allOperations: async ({ model, args, query }) => pictures(model, await query(args)) } },
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
