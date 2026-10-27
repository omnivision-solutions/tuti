import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export { listen } from "./listen";

function createPrismaClient() {
  // No connection is opened until the first query, so a missing URL only fails
  // at query time. Apps validate DATABASE_URL on startup instead (builds don't
  // need it).
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
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
