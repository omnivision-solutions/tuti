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
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  }).$extends({
    // A profile picture is saved as its stored file's key (or, from elsewhere, its address): read as a link. On the
    // results as they come, not as a result extension, whose objects carry a symbol React won't pass to the browser.
    query: { $allModels: { $allOperations: async ({ args, query }) => withPictures(await query(args)) } },
    // Typed as the plain client: the extension changes the field's value, not its type (string | null), and code
    // across the apps types transactions as Prisma.TransactionClient, which an extended client's type isn't.
  }) as unknown as PrismaClient;
}

/** Users in a result (at any depth) with their picture as a link (only users have `image`; pictureUrl leaves any other value). */
function withPictures<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(withPictures);
  } else if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const row = value as Record<string, unknown>;
    if (typeof row.image === "string") {
      row.image = pictureUrl(row.image);
    }
    Object.values(row).forEach(withPictures);
  }
  return value;
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
