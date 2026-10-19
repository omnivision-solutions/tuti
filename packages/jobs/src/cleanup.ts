import { mediaKeys } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";
import { mediaStorage } from "@tuti/shared/storage";

import type { JobLogger, JobResult } from "./index";

/** How long an upload may wait to be used in saved content. */
export const UNUSED_UPLOAD_HOURS = 24;
const BATCH = 500;

/**
 * Deletes uploads that no saved content uses a day after they started (people
 * who uploaded and never posted, failed uploads). Rows are claimed first, in one
 * statement that only takes still-unused uploads: content being saved marks its
 * uploads used in the same transaction (server/content.ts `attachMedia`) and rolls
 * back if one is gone, so files are never deleted from under saved content.
 * ponytail: a file whose delete fails is logged and left behind (nothing points
 * at it); runs hourly in batches of 500.
 */
export async function cleanupMedia(_input: JobInput<"cleanupMedia">, log: JobLogger): Promise<JobResult> {
  const storage = mediaStorage();
  if (!storage) {
    return { skipped: true };
  }
  const cutoff = new Date(Date.now() - UNUSED_UPLOAD_HOURS * 60 * 60 * 1000);
  const claimed = await prisma.$queryRaw<{ id: string; width: number | null }[]>`
    DELETE FROM media
    WHERE id IN (
      SELECT id FROM media WHERE "attachedAt" IS NULL AND "createdAt" < ${cutoff} LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
    )
    AND "attachedAt" IS NULL
    RETURNING id, width`;

  let failed = 0;
  for (const media of claimed) {
    for (const key of mediaKeys(media)) {
      try {
        await storage.delete(key);
      } catch (error) {
        failed++;
        log.warn(`couldn't delete ${key}: ${(error as Error).message}`);
      }
    }
  }
  log.info(`deleted ${claimed.length} unused upload(s); ${failed} file(s) couldn't be deleted`);
  return { deleted: claimed.length, failedFiles: failed };
}
