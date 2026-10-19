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
 * who uploaded and never posted, failed uploads), files first, then the rows.
 * ponytail: runs hourly in batches of 500; loop until done if uploads outpace that.
 */
export async function cleanupMedia(_input: JobInput<"cleanupMedia">, log: JobLogger): Promise<JobResult> {
  const storage = mediaStorage();
  if (!storage) {
    return { skipped: true };
  }
  const stale = await prisma.media.findMany({
    where: { attachedAt: null, createdAt: { lt: new Date(Date.now() - UNUSED_UPLOAD_HOURS * 60 * 60 * 1000) } },
    select: { id: true, width: true },
    take: BATCH,
  });
  for (const media of stale) {
    for (const key of mediaKeys(media)) {
      await storage.delete(key);
    }
  }
  await prisma.media.deleteMany({ where: { id: { in: stale.map((m) => m.id) } } });
  log.info(`deleted ${stale.length} unused upload(s)`);
  return { deleted: stale.length };
}
