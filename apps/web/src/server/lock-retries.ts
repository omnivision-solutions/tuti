import { Prisma } from "@tuti/db";

/** Postgres gave up on a transaction for its locks: a deadlock (40P01) or a serialization failure (40001; Prisma's P2034). */
export const lockConflict = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || /\b(40P01|40001)\b/.test(`${error.message} ${JSON.stringify(error.meta ?? {})}`));

/**
 * Runs `run` (a whole transaction) again when Postgres aborts it for its locks, up to `tries` times in all; any other
 * error, or the last try's, is thrown.
 */
export async function withLockRetries<T>(run: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= tries || !lockConflict(error)) {
        throw error;
      }
    }
  }
}
