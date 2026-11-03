import { prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";

import type { JobLogger, JobResult } from "./index";

/** How many days the docs' insights (docs.insights) cover, today included. */
export const INSIGHTS_DAYS = 30;

/** How long searches' daily counts and failed searches' words are kept, in whole UTC days: Reporting's longest range (Past year). */
export const SEARCHES_KEPT_DAYS = 365;

/** How many different failed searches' words are kept per project and day; more still count, without their words. */
export const FAILED_SEARCHES_PER_DAY = 100;

/** Removes docs searches' daily counts and failed searches older than Reporting shows (SEARCHES_KEPT_DAYS). */
export async function pruneDocsSearches(_input: JobInput<"pruneDocsSearches">, log: JobLogger): Promise<JobResult> {
  const since = new Date(new Date().toISOString().slice(0, 10));
  since.setUTCDate(since.getUTCDate() - (SEARCHES_KEPT_DAYS - 1));
  const [days, failed] = await prisma.$transaction([
    prisma.docsSearchDay.deleteMany({ where: { day: { lt: since } } }),
    prisma.docsFailedSearchDay.deleteMany({ where: { day: { lt: since } } }),
  ]);
  log.info(`pruned ${days.count} day(s) of docs searches and ${failed.count} failed search(es) older than ${SEARCHES_KEPT_DAYS} days`);
  return { days: days.count, failed: failed.count };
}
