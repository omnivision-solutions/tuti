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

/** An upload stays attached for this long after the last save of content that uses it. */
export const RELEASE_AFTER_HOURS = 24;

/**
 * Releases uploads that no content in their project uses any more (content deleted, or
 * edited out of it): `cleanupMedia` deletes them on its next hourly run (they were uploaded
 * more than a day ago) and their quota frees.
 * A sweep rather than bookkeeping on every delete: it reads what's saved, so no delete or
 * edit path can forget to free something. "Uses" means an image node in any post, comment,
 * changelog entry, help article (deleted ones too, until `purgeArticles` removes them) or
 * kept article revision, plus the project's branding images. A new column that holds a media
 * id must be added to `used` below, or its uploads are released and deleted.
 *
 * Races: every save marks its uploads attached again (`attachMedia`, now), and the release
 * is one statement that only takes uploads attached before the cutoff. A save that
 * committed before the statement started is seen; one still running when the statement
 * reaches its upload either holds the row (Postgres re-checks `attachedAt` on the saved
 * row, now recent, and skips it) or attaches it again after the release. The day also
 * lets someone put back an image they just edited out.
 * ponytail: one statement per project scanning all its content; daily, so fine until a
 * project has millions of rows (then keep a media id list per row, maintained on save).
 */
export async function releaseMedia(_input: JobInput<"releaseMedia">, log: JobLogger): Promise<JobResult> {
  const cutoff = new Date(Date.now() - RELEASE_AFTER_HOURS * 60 * 60 * 1000);
  const projects = await prisma.$queryRaw<{ projectId: string }[]>`
    SELECT DISTINCT "projectId" FROM media WHERE "attachedAt" < ${cutoff}`;
  let released = 0;
  for (const { projectId } of projects) {
    released += await prisma.$executeRaw`
      WITH content AS (
        SELECT content FROM post WHERE "projectId" = ${projectId}
        UNION ALL SELECT c.content FROM comment c JOIN post p ON p.id = c."postId" WHERE p."projectId" = ${projectId}
        UNION ALL SELECT content FROM changelog_entry WHERE "projectId" = ${projectId}
        UNION ALL SELECT content FROM article WHERE "projectId" = ${projectId}
        UNION ALL SELECT r.content FROM article_revision r JOIN article a ON a.id = r."articleId" WHERE a."projectId" = ${projectId}
      ),
      used AS (
        SELECT jsonb_path_query(content, '$.**.mediaId') #>> '{}' AS id FROM content WHERE content IS NOT NULL
        -- The project's branding images (logos, favicon).
        UNION ALL SELECT unnest(ARRAY["brandLogoId", "brandLogoDarkId", "brandFaviconId"]) FROM project WHERE id = ${projectId}
      )
      UPDATE media SET "attachedAt" = NULL
      WHERE "projectId" = ${projectId}
        AND "attachedAt" < ${cutoff}
        AND id NOT IN (SELECT id FROM used WHERE id IS NOT NULL)`;
  }
  log.info(`released ${released} upload(s) no content uses any more, in ${projects.length} project(s)`);
  return { released, projects: projects.length };
}
